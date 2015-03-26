'use strict';

var fs = require("graceful-fs");

class WallabyInputFileSystem {
  constructor(webpackPostprocessor) {
    this._postprocessor = webpackPostprocessor;
  }

  isSync() {
    return false;
  }

  stat() {
    return fs.stat.apply(fs, arguments);
  }

  readdir() {
    return fs.readdir.apply(fs, arguments);
  }

  readFile(filePath, callback) {
    //console.log('file read', filePath, new Error().stack);
    // for tracked files, reading file from wallaby cache (it will read it from disk if required)
    var allTrackedFiles = this._postprocessor.getAllTrackedFiles();
    var trackedFile = allTrackedFiles[filePath];
    if (trackedFile) {
      return trackedFile.getContent()
        .then(function (source) {
          callback(null, source);
        })
        .fail(function (err) {
          callback(err);
        });
    }
    // for other files just reading from disk
    return fs.readFile.apply(fs, arguments);
  }
}

module.exports = WallabyInputFileSystem;