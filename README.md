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

## Notes

### Webpack options
To make your tests run as fast as possible, only specify options that you need for your tests to run to avoid doing anything that would make each test run slower. When possible, consider using [IgnorePlugin](http://webpack.github.io/docs/list-of-plugins.html#ignoreplugin) for dependencies that you don't test, for example for styles or templates that are not used in your tests.

You don't need to specify any output options because wallaby-webpack doesn't use concatenated bundle. While concatenating files is beneficial for a production environment, in a testing environment it is different.
 Serving a large bundle every time when one of many files (that the bundle consists of) changes, is wasteful.
 So instead, each compiled module code is passed to wallaby, wallaby caches it in memory (and when required, writes
 it to disk) and serves each requested module file separately to properly leverage browser caching.

For your tests you don't have to use the module bundler loaders and where possible may use [wallaby.js preprocessors](https://github.com/wallabyjs/public#preprocessors-setting) instead. For example, if you are using ES6, instead of using `babel-loader` in the webpack configuration, you may specify wallaby.js preprocessor(s):

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
### Files and tests
All source files and tests (except external files/libs) must have `load: false` set, because wallaby will load wrapped versions of these files on `window.__moduleBundler.loadTests()` call in `bootstrap` function. Node modules should not be listed in the `files` list, they are loaded automatically.

Source files order doesn't matter, so patterns can be used instead of listing all the files.

Code inside each file is wrapped in such a way that when the file is loaded in browser, it doesn't execute
 the code immediately. Instead, it just adds some function, that executes the file code, to test loader's cache. Tests and dependent files are loaded from wallaby `bootstrap` function, by calling `__moduleBundler.loadTests()`, and then executed.
