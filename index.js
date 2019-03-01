'use strict';

var path = require('path');
var _ = require('lodash');
var mm = require('minimatch');
var WallabyInputFileSystem = require('./lib/WallabyInputFileSystem');

/*
 Postprocessor for wallaby.js runs module bundler compiler incrementally
 to only build changed or not yet built modules. The compiler is stopped from emitting the bundle/chunks to disk,
 because while concatenating files is beneficial for production environment, in testing environment it is different.
 Serving a large bundle/chunk every time when one of many files (that the bundle consists of) changes, is wasteful.
 So instead, each compiled module code is passed to wallaby,  wallaby caches it in memory (and when required, writes
 it on disk) and serves each requested module file separately to properly leverage browser caching.

 Apart from emitting module files, the postprocessor also emits a test loader script that executes in browser before
 any modules. The test loader sets up a global object so that each wrapped module can add itself to the loader cache.

 Each module code is wrapped in such a way that when the module file is loaded in browser, it doesn't execute
 the module code immediately. Instead, it just adds the function that executes the module code to test loader's cache.

 Modules are loaded from tests (that are entry points) when the tests are loaded. The tests are loaded from wallaby
 bootstrap function, by calling `__moduleBundler.loadTests()`.

 When wallaby runs tests first time, browser caches all modules and each subsequent test run only needs to load  a
 changed module files from the server (and not the full bundle). If new modules detected, the the test loader script,
 that sets up module dependencies object, is also reloaded.
 */

class WebpackPostprocessor {

  constructor(opts) {
    this._loaderEmitRequired = false;

    this._opts = opts || {};

    this._webpack = this._opts.webpack;

    this._entryPatterns = this._opts.entryPatterns;
    this._emitModulePaths = this._opts.emitModulePaths;
    this._preserveEntryFileLoadOrder = this._opts.preserveEntryFileLoadOrder;
    delete this._opts.webpack;
    delete this._opts.entryPatterns;
    delete this._opts.preserveEntryFileLoadOrder;
    delete this._opts.emitModulePaths;
    delete this._opts.mode;
    this._opts.entry = {};

    if (this._entryPatterns && _.isString(this._entryPatterns)) {
      this._entryPatterns = [this._entryPatterns];
    }

    this._compilationCache = {};
    this._compilationFileTimestamps = {};
    this._affectedModules = [];
    this._moduleIds = {};
    this._moduleIdByPath = {};
    this._modulePathById = {};
    this._allTrackedFiles = {};
    this._entryFiles = {};
    this._testDependencies = {};
    this._testFilePathById = {};
    this._inputFileSystem = new WallabyInputFileSystem(this);
  }

  getAllTrackedFiles() {
    return this._allTrackedFiles;
  }

  createPostprocessor() {
    var self = this;

    if (!this._webpack) {
      this._webpack = WebpackPostprocessor._tryRequireFrom('webpack')
        || WebpackPostprocessor._tryRequireFrom('react-scripts/node_modules/webpack')
        || WebpackPostprocessor._tryRequireFrom('angular-cli/node_modules/webpack')
        || WebpackPostprocessor._tryRequireFrom('@angular-devkit/build-angular/node_modules/webpack');
    }

    if (!this._webpack) {
      console.error('Webpack node module is not found, missing `npm install webpack --save-dev`?');
      return;
    }

    return wallaby => {
      var logger = wallaby.logger;
      var affectedFiles = WebpackPostprocessor._fileArrayToObject(wallaby.affectedFiles);

      if (!self._compiler || wallaby.anyFilesAdded || wallaby.anyFilesDeleted) {

        if (!self._compiler) {
          logger.debug('New compiler created');
        }
        else {
          logger.debug('Compiler re-created because some tracked files were added or deleted');
        }

        affectedFiles = self._allTrackedFiles = WebpackPostprocessor._fileArrayToObject(wallaby.allFiles);

        var entryPatternsNotMatchingAnyFiles = _.reduce(self._entryPatterns || [], function (memo, p) {
          memo[p] = p;
          return memo;
        }, {});
        // Entry files ordered by entry pattern index
        self._entryFiles = _.reduce(!self._entryPatterns
          ? wallaby.allTestFiles
          : _.sortBy(_.filter(self._allTrackedFiles, file => {
            var satisfiesAnyEntryPattern = _.find(self._entryPatterns, (pattern, patternIndex) => (file.patternIndex = patternIndex, mm(file.path, pattern)));
            if (!satisfiesAnyEntryPattern) {
              delete file.patternIndex;
            } else {
              delete entryPatternsNotMatchingAnyFiles[satisfiesAnyEntryPattern];
            }

            return satisfiesAnyEntryPattern;
          }), 'patternIndex'),
          function (memo, file) {
            delete file.patternIndex;
            memo[file.fullPath] = file;
            return memo;
          }, {});
        if (!_.isEmpty(entryPatternsNotMatchingAnyFiles)) {
          _.each(entryPatternsNotMatchingAnyFiles, p => logger.error('Specified entry pattern "' + p + '" does not match any file.'));
        }
        self._compiler = self._createCompiler({
          cache: false,   // wallaby post processor is using its own cache
          entry: _.reduce(self._entryFiles, (memo, entryFile) => {
            memo[entryFile.fullPath] = entryFile.fullPath;
            return memo;
          }, {})
        }, wallaby.nodeModulesDir);

        self._affectedModules = [];
        self._moduleIds = {};
        self._compilationCache = {};
        self._compilationFileTimestamps = {};
        self._testDependencies = {};
        self._testFilePathById = {};

        self._loaderEmitRequired = true;
        self._fullRun = true;
      } else {
        self._fullRun = false;
      }

      // cache invalidation for changed files
      _.each(affectedFiles, file => {
        self._compilationFileTimestamps[file.fullPath] = +new Date();
      });

      return new Promise(
        function (resolve, reject) {
          try {
            logger.debug('Webpack compilation started');
            // incremental bundling
            self._compiler.compile((err, stats) => {
              if (err) {
                reject(err);
                return;
              }
              var lastCompilation = self._compiler.lastCompilation;
              if (lastCompilation && lastCompilation.errors && lastCompilation.errors.length) {
                _.each(lastCompilation.errors, e => logger.error(((typeof e === 'string') && e) || e && ((e.message || '') + (e.stack || ''))));
              }

              resolve();
            });
          } catch (err) {
            reject(err);
          }
        })
        .then(function () {
          logger.debug('Webpack compilation finished');
          var createFilePromises = [];

          if (!self._fullRun) {
            self._affectedModules = self._addHarmonyModulesAffectedDependencies(self._affectedModules, affectedFiles);
          }

          _.each(self._affectedModules, function (m) {
            var trackedFile = m.resource && affectedFiles[m.resource];
            var isEntryFile = trackedFile && self._entryFiles[trackedFile.fullPath];
            var isTestFile = trackedFile && trackedFile.test;
            var source = self._getSource(m, trackedFile);
            var code = source.code;
            var sourceMap = trackedFile && source.map();

            if (isTestFile && m.dependencies) {
              var depIds = [];
              self._traverseDependencies(m.dependencies, d => d.module, (m, f) => depIds.push(f.id), {});
              self._testDependencies[trackedFile.id] = depIds;
            }

            createFilePromises.push(wallaby.createFile({
              // adding the suffix to store webpack file along with the original copies for tracked files
              // for non-tracked files path/name doesn't matter, just has to be unique for each file
              path: trackedFile
                // adding id because same resource may be loaded more than once with different ids, for example:
                // var a = require('./a'); var b = require('imports?window=mocked!./a');
                ? (trackedFile.path + ((_.isNumber(m.id) && !isTestFile) ? ('.' + m.id) : '') + '.wbp.js')
                : path.join('__modules', m.id + '.js'),
              original: trackedFile,
              content: code,
              sourceMap: sourceMap,
              order: (isEntryFile && self._entryPatterns) ? trackedFile.order : undefined
            }));

            // if the file is not tracked, preventing re-build it
            if (m.resource && !trackedFile) {
              self._compilationFileTimestamps[m.resource] = 1;
            }

            // caching test entry modules by file path so that we can load them from __moduleBundler.loadTests
            var moduleId = WebpackPostprocessor._getModuleId(m, trackedFile, isEntryFile);
            if (!self._moduleIds[moduleId]) {
              self._moduleIds[moduleId] = m.id;
              // modules unknown so far force test loader script reload
              self._loaderEmitRequired = true;
            }
            if (self._emitModulePaths) {
              self._modulePathById[moduleId] = m.resource;
            }
            if (trackedFile) {
              self._moduleIdByPath[trackedFile.fullPath] = moduleId;
            }
            if (isTestFile) {
              self._testFilePathById[m.id] = trackedFile.path;
            }
          });

          // resetting till next incremental bundle run
          self._affectedModules = [];

          // test loader script for wallaby.js
          if (self._loaderEmitRequired) {
            self._loaderEmitRequired = false;
            createFilePromises.push(wallaby.createFile({
              order: -1,  // need to be the first file to load
              path: 'wallaby-webpack.js',
              content: WebpackPostprocessor._getLoaderContent()
                + 'window.__moduleBundler.deps = '
                // dependency lookup
                + JSON.stringify(self._moduleIds) + ';'
                + (self._emitModulePaths ? ('window.__moduleBundler.depPaths = ' + JSON.stringify(self._modulePathById) + ';') : '')
                + 'window.__moduleBundler.testFilePathById = ' + JSON.stringify(self._testFilePathById) + ';'
            }));

            // Executing all entry files
            if (self._entryPatterns && self._entryFiles && !_.isEmpty(self._entryFiles)) {
              var entryFilesToLoad = _.values(self._entryFiles);
              createFilePromises.push(wallaby.createFile({
                order: self._preserveEntryFileLoadOrder ? entryFilesToLoad[0].order : Infinity,
                path: 'wallaby_webpack_entry.js',
                content: _.reduce(entryFilesToLoad,
                  (memo, file) => memo + (file.test ? '' : 'window.__moduleBundler.require(' + JSON.stringify(self._moduleIdByPath[file.fullPath]) + ');'), '')
              }));
            }
          }

          logger.debug('Emitting %s files', createFilePromises.length);

          return Promise.all(createFilePromises).then(function () {
            return {testDependencies: self._testDependencies};
          });
        });
    };
  }

  _addHarmonyModulesAffectedDependencies(affectedModules, affectedFiles) {
    var self = this;
    var allAffectedModules = {};
    var allAffectedModulesList = [];
    var visitedDeps = {};
    _.each(affectedModules, m => {
      if (!_.isNumber(m.id)) {
        allAffectedModulesList.push(m);
      } else {
        allAffectedModules[m.id] = m;
      }
      if (m.dependencies) {
        self._traverseDependencies(
          m.dependencies,
          dep => dep && dep.constructor && (typeof dep.constructor.name === 'string')
            && (dep.constructor.name.indexOf('HarmonyExport') === 0) && dep.originModule && dep.originModule.issuer,
          (m, f) => {
            if (_.isNumber(m.id)) {
              allAffectedModules[m.id] = m;
            } else {
              allAffectedModulesList.push(m);
            }
            if (f) {
              affectedFiles[m.resource] = f;
            }
          },
          visitedDeps
        );
      }
    });
    return allAffectedModulesList.concat(_.values(allAffectedModules));
  }

  _traverseDependencies(deps, moduleGetter, onDependency, visitedDeps) {
    var self = this;
    _.each(deps, function (dep) {
      if (!dep) return;
      var m = moduleGetter(dep);
      if (!m) return;
      var depResourceId = m.resource || '';
      if (visitedDeps[depResourceId]) return;
      visitedDeps[depResourceId] = true;
      var trackedDepFile = m.resource && self._allTrackedFiles[m.resource];
      if (trackedDepFile) onDependency(m, trackedDepFile, dep);
      self._traverseDependencies(m.dependencies, moduleGetter, onDependency, visitedDeps);
    });
  }

  static _fileArrayToObject(files) {
    return _.reduce(files, function (memo, file) {
      memo[file.fullPath] = file;
      return memo;
    }, {});
  }

  _createCompiler(mandatoryOpts, nodeModulesDir) {
    var isOptionsSchemaEnforced = !!this._webpack.validate;
    var hasMode = !!this._webpack.web;
    if (hasMode) {
      this._opts.mode = 'none';
    }

    var mergedOpts = _.merge({}, this._opts, mandatoryOpts);

    WebpackPostprocessor._configureModules('modules', false, nodeModulesDir, this._opts, mergedOpts);
    WebpackPostprocessor._configureModules('modules', true, nodeModulesDir, this._opts, mergedOpts);
    if (!isOptionsSchemaEnforced) {
      WebpackPostprocessor._configureModules('modulesDirectories', false, nodeModulesDir, this._opts, mergedOpts);
      WebpackPostprocessor._configureModules('modulesDirectories', true, nodeModulesDir, this._opts, mergedOpts);
    }

    return this._configureCompiler(this._webpack(mergedOpts));
  }

  static _configureModules(modulesSettingName, isForLoaderResolve, modulesDir, userOptions, effectiveOptions) {
    var resolvePath = 'resolve' + (isForLoaderResolve ? 'Loader' : '');
    var effectiveOptionsResolve = effectiveOptions[resolvePath] = effectiveOptions[resolvePath] || {};

    var modules = effectiveOptionsResolve[modulesSettingName] =
      ((userOptions[resolvePath] || {})[modulesSettingName] || []).concat(['node_modules']);

    if (modulesDir) modules.push(modulesDir);

    if (!userOptions[resolvePath] || !userOptions[resolvePath][modulesSettingName] || !userOptions[resolvePath][modulesSettingName].length) {
      modules.push('web_modules');
      if (isForLoaderResolve) {
        modules.push('node_loaders');
        modules.push('web_loaders');
      }
    }
  }

  _configureCompiler(compiler) {
    var self = this;
    compiler.plugin('this-compilation', function (compilation) {

      compiler.lastCompilation = compilation;
      compilation.cache = self._compilationCache;
      self._compilationFileTimestamps.get = function (f) {
        return self._compilationFileTimestamps[f];
      };
      compilation.fileTimestamps = self._compilationFileTimestamps;
      self._moduleTemplate = (compilation.moduleTemplates && compilation.moduleTemplates.javascript) || compilation.moduleTemplate;
      self._dependencyTemplates = compilation.dependencyTemplates;

      compilation.plugin('build-module', function (m) {
        self._affectedModules.push(m);
      });

      // Some plugins and operations are not necessary in wallaby context and very time consuming with many chunks

      self._removePlugins('', compilation);
      self._removePlugins(0, compilation);
      self._removePlugins(1, compilation);
      self._removePlugins(2, compilation);

      compilation.createHash = function () {
        this.hash = '';
      };
      compilation.plugin('should-generate-chunk-assets', function () {
        return false;
      });
      compilation.processDependenciesBlockForChunk
        = compilation.processDependenciesBlocksForChunks
        = compilation.processDependenciesBlocksForChunkGroups
        = compilation.sortItemsWithModuleIds
        = compilation.sortItemsWithChunkIds = function () {
      };
    });

    // no need to emit chunks as we emit individual modules
    compiler.plugin('should-emit', function (compilation) {
      return false;
    });

    compiler.inputFileSystem = self._inputFileSystem;
    return compiler;
  }


  _removePlugins(i, compilation) {
    var name = 'applyPlugins' + i;
    var originalApplyPlugins = compilation['applyPlugins' + i];
    if (originalApplyPlugins) {
      compilation[name] = function (name) {
        if (name === 'optimize-module-order' || name === 'optimize-chunk-order' || name === 'optimize-chunk-ids') return;
        return originalApplyPlugins.apply(this, arguments);
      };
    } else if (compilation.hooks) {
      compilation.hooks.optimizeModuleOrder
        = compilation.hooks.optimizeChunkOrder
        = compilation.hooks.optimizeChunkIds = {call: a => a, tap: a => a};
    }
  }

  _getSource(m, file) {
    var self = this;
    // to avoid wrapping module into a function, we do it a bit differently in _wrapSourceFile
    self._moduleTemplate._plugins && (self._moduleTemplate._plugins['render'] = []);
    self._moduleTemplate.hooks && (self._moduleTemplate.hooks['render'] = {call: a => a, tap: a => a});

    var node = self._moduleTemplate.render(m, self._dependencyTemplates, {modules: [m]});

    return {
      code: WebpackPostprocessor._wrapSourceFile(WebpackPostprocessor._getModuleId(m, file, self._isEntryFile(file)), node.source(), m.strict),
      map: () => node.map()
    };
  }

  _isEntryFile(file) {
    return this._entryPatterns && file && !!this._entryFiles[file.fullPath];
  }

  static _tryRequireFrom(location) {
    try {
      return require(location);
    }
    catch (e) {
      return false;
    }
  }

  static _getModuleId(m, file, isEntryFile) {
    var testFile = file && file.test;
    if (m.meta && m.meta['aurelia-id']) return m.meta['aurelia-id'];
    if (m.buildMeta && m.buildMeta['aurelia-id']) return m.buildMeta['aurelia-id'];
    if (testFile || !_.isNumber(m.id) || isEntryFile) return m.resource;
    return m.id;
  }

  static _wrapSourceFile(id, content, useStrict) {
    return 'window.__moduleBundler.cache[' + JSON.stringify(id) + '] = [function(__webpack_require__, module, exports, __webpack_exports__) {'
      + (useStrict ? '"use strict";' : '')
      + content + '\n}, window.__moduleBundler.deps];';
  }

  static _getLoaderContent() {
    // webpack prelude, taken from browserify,
    // modified to include webpack specific module.id, module.loaded (and module.i, module.l and module.e for Webpack 2),
    // __webpack_require__.e (require.ensure),
    // __webpack_require__.m,
    // __webpack_require__.c,
    // __webpack_require__.p,
    // __webpack_require__.i,
    // __webpack_require__.d,
    // __webpack_require__.n,
    // __webpack_require__.o,
    // __webpack_require__.t,
    // (see webpack/lib/MainTemplate.js)
    var prelude = '(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var tfp=window.__moduleBundler.testFilePathById[o];if(tfp){throw new Error("Test file "+tfp+" is being imported from other test files.\\nThis may cause tests in the file to be executed more than once (when the test file runs and every time it gets imported).\\nIf the test file contains some test helper code, try refactoring the reused code into a file of its own and use it by importing the new helper file where required.")}var f=new Error("Cannot find module \'"+o+"\'"+(window.__moduleBundler.depPaths?" (" + window.__moduleBundler.depPaths[o]+")":""));throw f.code="MODULE_NOT_FOUND",f}var exp={};var mid=o;try{mid=o.toString();}catch(emid){}var l=n[o]={exports:exp,e:exp,id:mid,i:mid,loaded:false,l:false};var rq=function(e){var n=t[o][1][e];return s(n?n:e)};rq.e=function(a1,a2){if(a2){a2.call(null,rq);}else{return Promise.resolve();}};rq.m=tm;rq.c=n;rq.p="";rq.i=function(value){return value;};rq.d=function(exports,name,getter){Object.defineProperty(exports,name,{configurable:false,enumerable:true,get:getter});};rq.o=function(object,property){return Object.prototype.hasOwnProperty.call(object,property);};rq.t=function(value,mode){if(mode&1)value =rq(value);if(mode&8)return value;if((mode&4)&&typeof value==="object"&&value&&value.__esModule)return value;var ns = Object.create(null);rq.r(ns);Object.defineProperty(ns,"default",{enumerable:true,value:value});if(mode&2&&typeof value!="string")for(var key in value)rq.d(ns,key,function(key){return value[key];}.bind(null, key));return ns;};rq.r=function(exports){Object.defineProperty(exports,\'__esModule\',{value:true});};rq.n=function(module){var getter=module&&module.__esModule ? function getDefault(){return module["default"];} : function getModuleExports(){return module;};rq.d(getter,"a",getter);return getter;};t[o][0].call(exp,rq,l,exp,exp,e,t,n,r);l.exports=l.e=((exp===l.e)?l.exports:l.e);l.l=true;if(Object.getOwnPropertyDescriptor(l, "loaded").writable){l.loaded=true}}return n[o].exports}var tm={};for(var pr in t){if(t.hasOwnProperty(pr)){tm[pr]=(function(orf){return function(md,mde,wrq){return orf.call(this,wrq,md,mde);}})(t[pr][0]);}}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})';
    return 'window.__moduleBundler = {};'
      + 'window.__moduleBundler.cache = {};'
      + 'window.__moduleBundler.moduleCache = {};'
      + 'window.__moduleBundler.require = function (m) {'
      + prelude
      + '(window.__moduleBundler.cache, window.__moduleBundler.moduleCache, [m]);'
      + '};'
      + 'window.__moduleBundler.loadTests = function () { window.wallaby._startWhenReceiverIsReady(function() {'
      + prelude
      // passing accumulated files and entry points (webpack-ed tests for the current sandbox)
      + '(window.__moduleBundler.cache, window.__moduleBundler.moduleCache, (function(){ var testIds = []; for(var i = 0, len = wallaby.loadedTests.length; i < len; i++) { var test = wallaby.loadedTests[i]; if (test.substr(-7) === ".wbp.js") testIds.push(wallaby.baseDir + test.substr(0, test.length - 7)); } return testIds; })());'
      + '});};'
  }
}

module.exports = function (opts) {
  return new WebpackPostprocessor(opts).createPostprocessor();
};
