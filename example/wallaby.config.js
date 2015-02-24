var webpack = require('../');

var webpackConfig = {
    module: {
        loaders: [
            {test: /\.coffee$/, loader: "coffee"}
        ]
    },
    resolve: {
        extensions: ["", ".web.coffee", ".web.js", ".coffee", ".js"]
    },
    context: __dirname
};

module.exports = {
    "files": [
        "a.coffee",
        "b.coffee",
        "../index.js"
    ],
    "tests": [
        "*.spec.coffee"
    ],
    preprocessors: {
        "**/*.coffee": webpack(webpackConfig),
        "**/*.js": webpack(webpackConfig)
    },
    testFramework: 'mocha@2.0.1'
};

