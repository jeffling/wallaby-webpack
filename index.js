var webpack = require('webpack');
var MemoryFileSystem = require('memory-fs');
var convert = require('convert-source-map');

var compilerCache = {};

var webpackPreprocessor = function (options) {
    options.watch = null;
    options.entry = null;
    options.output = options.output || {};
    options.output.path = options.output.path || process.cwd();
    options.output.filename = options.output.filename || '[hash].js';
    options.context = options.context || __dirname;
    options.devtool = options.devtool || "#inline-source-map";

    function compilerCallback (done) {
        return function (err, stats) {
            if (err) {
                done(err);
                return;
            }

            if (stats) {
                if (stats.hasErrors()) {
                    done(new Error(stats.toJson().errors));
                }
                else {
                    console.info(stats.toString({color: true}));
                }
            }
        }
    }

    return function(file, done) {
        if (compilerCache[file.path]){
            compilerCache[file.path].wallabyDone = done;
            compilerCache[file.path].run(compilerCallback(done));
        }
        else {
            options.entry = './' + file.path;

            var compiler = webpack(options, compilerCallback);
            compiler.wallabyDone = done;

            // ripped out of gulp-webpack
            var fs = compiler.outputFileSystem = new MemoryFileSystem();
            compiler.plugin('after-emit', function (compilation, callback) {
                Object.keys(compilation.assets).forEach(function (outname) {
                    if (compilation.assets[outname].emitted) {
                        var filePath = fs.join(compiler.outputPath, outname);

                        var resultFile = {
                            code: fs.readFileSync(filePath).toString()
                        };
                        file.rename(outname);
                        var sourceMapConverter = convert.fromSource(resultFile.code);
                        if (sourceMapConverter) {
                            resultFile.map = sourceMapConverter.toJSON();
                        }
                        compiler.wallabyDone(resultFile);
                    }
                });
                callback();
            });

            compilerCache[file.path] = compiler;
        }
    }
};

module.exports = webpackPreprocessor;
