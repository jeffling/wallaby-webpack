# wallaby-webpack

Wallaby.js postprocessor to support webpack.

## Installation

``` sh
npm install wallaby-webpack --save-dev
```

## Usage

``` javascript
// Wallaby.js configuration

var wallabyWebpack = require('wallaby-webpack');
var wallabyPostprocessor = wallabyWebpack({
    // webpack options, such as
    // module: {
    //   loaders: [
    //     {
    //       test: /\.js$/,
    //       exclude: /node_modules/,
    //       loader: 'babel-loader'
    //     }
    //   ]
    // },
    // externals: { jquery: "jQuery" }
  }
);

module.exports = function () {
  return {
    // set `load: false` to all of source files and tests processed by webpack
    // (except external files),
    // as they should not be loaded in browser,
    // their wrapped versions will be loaded instead
    files: [
      // {pattern: 'lib/jquery.js', instrument: false},
      {pattern: 'src/*.js', load: false}
    ],

    tests: [
      {pattern: 'test/*Spec.js', load: false}
    ],

    postprocessor: wallabyPostprocessor,

    bootstrap: function () {
      // required to trigger tests loading
      window.__moduleBundler.loadTests();
    }
  };
};
```

You may also consider re-using your existing webpack config by requiring it in wallaby config and adjusting the way you need.
``` javascript
var webpackConfig = require('./webpack.config');

// Adjust the config as required
// webpackConfig.plugins.push(...);

var wallabyPostprocessor = wallabyWebpack(webpackConfig);
```

## Notes

### Webpack options
To make your tests run as fast as possible, only specify options that you need for your tests to run to avoid doing anything that would make each test run slower. When possible, consider using [IgnorePlugin](http://webpack.github.io/docs/list-of-plugins.html#ignoreplugin) for dependencies that you don't test, for example for styles or templates that are not used in your tests.

You don't need to specify any output options because wallaby-webpack doesn't use concatenated bundle. While concatenating files is beneficial for a production environment, in a testing environment it is different.
 Serving a large bundle every time when one of many files (that the bundle consists of) changes, is wasteful.
 So instead, each compiled module code is passed to wallaby, wallaby caches it in memory (and when required, writes
 it to disk) and serves each requested module file separately to properly leverage browser caching.
 
Please note, that some webpack loaders, such as `babel-loader` require you to use `devtool` option in order to generate a source map, that is required in wallaby.js for the correct error stack mappings. Wallaby supported `devtool` values are: `source-map`, `hidden-source-map`, `cheap-module-source-map`.

**For better performance, consider not using webpack loaders in wallaby configuration, specifically those that require `devtool` and source maps, and use wallaby.js preprocessors or compilers instead as described below.**

For your tests you don't have to use the module bundler loaders and where possible may use wallaby.js [preprocessors](https://github.com/wallabyjs/public#preprocessors-setting) or []([compiler](https://github.com/wallabyjs/public#compilers-setting)) instead. 

For example, if you are using ES6/JSX, instead of using `babel-loader` in the webpack configuration, you may specify wallaby.js preprocessor:

``` javascript
    files: [
      {pattern: 'src/*.js', load: false}
    ],

    tests: [
      {pattern: 'test/*Spec.js', load: false}
    ],

    preprocessors: {
      '**/*.js': file => require('babel').transform(file.content, {sourceMap: true})
    },

    postprocessor: wallabyPostprocessor
```
or a compiler (recommended in case if you are using or planning to use ES7 features, with [proper `stage` value](https://babeljs.io/docs/usage/experimental/) passed to the compiler options):
``` javascript
    files: [
      {pattern: 'src/*.js', load: false}
    ],

    tests: [
      {pattern: 'test/*Spec.js', load: false}
    ],

    compilers: {
      '**/*.js': wallaby.compilers.babel({ babel: require('babel') /* , stage: 0 */ }),
    }

    postprocessor: wallabyPostprocessor
```
In this case, don't forget to remove `devtool` and not used loaders if you are using external webpack config as wallaby webpack config, for example:
```
  var webpackConfig = require('./webpack.config');
  
  // removing babel-loader, we will use babel compiler instead, it's more performant
  webpackConfig.module.loaders = webpackConfig.module.loaders.filter(function(l){
    return l.loader !== 'babel-loader';
  });

  delete webpackConfig.devtool;
  
  var wallabyPostprocessor = wallabyWebpack(webpackConfig);
```

### Files and tests
All source files and tests (except external files/libs) must have `load: false` set, because wallaby will load wrapped versions of these files on `window.__moduleBundler.loadTests()` call in `bootstrap` function. Node modules should not be listed in the `files` list, they are loaded automatically.

Source files order doesn't matter, so patterns can be used instead of listing all the files.

Code inside each file is wrapped in such a way that when the file is loaded in browser, it doesn't execute
 the code immediately. Instead, it just adds some function, that executes the file code, to test loader's cache. Tests and dependent files are loaded from wallaby `bootstrap` function, by calling `__moduleBundler.loadTests()`, and then executed.

### Module resolution issues
If you are observing `ModuleNotFoundError`, required module folders are referenced in a relative manner and didn't make it into the wallaby file cache, that wallaby is using to run your tests.

For example, if you are using `bower_components` and may have something like this in you config:
```javascript
    resolve: {
      modulesDirectories: ['bower_components']
    }
```
In this case, even though I would not recommend it, you may to add `{ pattern: 'bower_components/**/*.*', instrument: false, load: false }` to your files list, so that `bower_components` contents makes it into the wallaby cache and wallaby will be able to resolve modules from it.

The **more efficient approach** that I would recommend is to specify an absolute path in your wallaby configuration for webpack for your modules instead:
```javascript
    resolve: {
      modulesDirectories: [require('path').join(__dirname, 'bower_components')]
    }
```
This way you don't need to specify `bower_components` in your files list and wallaby will not have to copy it over to its cache.

The same applies to `resolve.fallback`, `resolve.root` and `resolveLoader` webpack configuration settings.

**Please note that you don't need to do a similar thing for `node_modules`, as wallaby-webapck automatically adds local project `node_modules` folder to the the fallback list**. Unlike `node_modules`, `bower_components` and any other custom module folders can be used with different names/paths, so wallaby doesn't try to automatically add them based on the name convention.
