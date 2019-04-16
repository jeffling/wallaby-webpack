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

  readlink() {
    return fs.readlink.apply(fs, arguments);
  }

  readFile(filePath, callback) {
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

  statSync() {
    return fs.statSync.apply(fs, arguments);
  }

  readdirSync() {
    return fs.readdirSync.apply(fs, arguments);
  }

  readFileSync(filePath) {
    // for tracked files, reading file from wallaby cache (it will read it from disk if required)
    var allTrackedFiles = this._postprocessor.getAllTrackedFiles();
    var trackedFile = allTrackedFiles[filePath];
    if (trackedFile) {
      return trackedFile.getContentSync();
    }
    // for other files just reading from disk
    return fs.readFileSync.apply(fs, arguments);
  }

  readJson(filePath, callback) {
    this.readFile(filePath, (err, content) => {
      if (err) {
        callback(err);
      } else {
        var obj;
        try {
          obj = JSON.parse(content);
          callback(null, obj);
        } catch (err2) {
          callback(err2);
        }
      }
    });
  }
}

module.exports = WallabyInputFileSystem;
