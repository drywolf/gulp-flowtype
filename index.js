/* @flow weak */
'use strict';
var Q = require('q');
var fs = require('fs');
require('babel/polyfill');
var path = require('path');
var gutil = require('gulp-util');
var through = require('through2');
var flowBin = require('flow-bin');
var logSymbols = require('log-symbols');
var { execFile, spawn } = require('child_process');
var flowToJshint = require('flow-to-jshint');
var stylishReporter = require(require('jshint-stylish')).reporter;
var path = require('path');

/**
 * Flow check initialises a server per folder when run,
 * we can store these paths and kill them later if need be.
 */
var servers = [];
var passed = true;

/**
 * Wrap critical Flow exception into default Error json format
 */
function fatalError(stderr) {
  return {
    errors: [{
      message: [{
        path: '',
        code: 0,
        line: 0,
        start: 0,
        descr: stderr
      }]
    }]
  };
}

function optsToArgs(opts) {
  var args = [];

  if (opts.all) {
    args.push('--all');
  }
  if (opts.weak) {
    args.push('--weak');
  }
  if (opts.declarations) {
    args.push('--lib', opts.declarations);
  }

  return args;
}

function getFlowBin() {
    return process.env.FLOW_BIN || flowBin;
}

// normalizes paths (especially important on windows)
function normalizePath(p) {
  return path.resolve(p);
}

function executeFlow(_path, options) {
  var deferred = Q.defer();

  var opts = optsToArgs(options);

  _path = normalizePath(_path);

  var command = opts.length ? (() => {
    servers.push(path.dirname(_path));
    return 'check';
  })() : 'status';

  var args = [
    command,
    ...opts,
    '/' + path.relative('/', _path),
    '--json'
  ];

  var stream = spawn(getFlowBin(), args);

  stream.stdout.on('data', data => {
    var parsed;
    try {
      parsed = JSON.parse(data.toString());
    }
    catch(e) {
      parsed = fatalError(data.toString());
    }
    var result = {};
    result.errors = parsed.errors.filter(function (error) {
      error.message = error.message.filter(function (message, index) {
        var isCurrentFile = normalizePath(message.path) === _path;
        var result = false;
        /**
         * If FlowType traces an issue to a method inside a file that is not
         * the one being piped through, it adds a new element to the list
         * of errors with a different file path to the current one. To detect
         * whether this error is related to the current file we check the
         * previous and next error to see if it ends with `found`, `in` or
         * `with`, From this we can tell if the error should be shown or not.
         */
        var lineEnding = /(with|found|in)$/;

        var previous = error.message[index - 1];
        if (previous && lineEnding.test(previous.descr)) {
          result = normalizePath(previous.path) === _path;
        }

        var nextMessage = error.message[index + 1];
        if (nextMessage && lineEnding.test(message.descr)) {
          result = normalizePath(nextMessage.path) === _path;
        }

        var generalError = (/(Fatal)/.test(message.descr));
        return isCurrentFile || result || generalError;
      });
      return error.message.length > 0;
    });

    if (result.errors.length) {
      passed = false;

      var reporter = typeof options.reporter === 'undefined' ?
        stylishReporter : options.reporter.reporter;

      reporter(flowToJshint(result));

      if (options.abort) {
        deferred.reject(new gutil.PluginError('gulp-flow', 'Flow failed'));
      }
      else {
        deferred.resolve();
      }
    }
    else {
      deferred.resolve();
    }
  });

  return deferred.promise;
}

function checkFlowConfigExist() {
  var deferred = Q.defer();
  var config = path.join(process.cwd(), '.flowconfig');
  fs.exists(config, function(exists) {
    if (exists) {
      deferred.resolve();
    }
    else {
      deferred.reject('Missing .flowconfig in the current working directory.');
    }
  });
  return deferred.promise;
}

function hasJsxPragma(contents) {
  return /@flow\b/ig
    .test(contents);
}

function isFileSuitable(file) {
  var deferred = Q.defer();
  if (file.isNull()) {
    deferred.reject();
  }
  else if (file.isStream()) {
    deferred.reject(new gutil.PluginError('gulp-flow', 'Stream content is not supported'));
  }
  else if (file.isBuffer()) {
    deferred.resolve();
  }
  else {
    deferred.reject();
  }
  return deferred.promise;
}

function killServers() {
  var defers = servers.map(function(_path) {
    var deferred = Q.defer();
    execFile(getFlowBin(), ['stop'], {
      cwd: _path
    }, deferred.resolve);
    return deferred;
  });
  return Q.all(defers);
}

module.exports = function (options={}) {
  options.beep = typeof options.beep !== 'undefined' ? options.beep : true;

  function Flow(file, enc, callback) {

    var _continue = () => {
      this.push(file);
      callback();
    };

    isFileSuitable(file).then(() => {
      var hasPragma = hasJsxPragma(file.contents.toString());
      if (options.all || hasPragma) {
        checkFlowConfigExist().then(() => {
          executeFlow(file.path, options).then(_continue, err => {
            this.emit('error', err);
            callback();
          });
        }, msg => {
          console.log(logSymbols.warning + ' ' + msg);
          _continue();
        });
      } else {
        _continue();
      }
    }, err => {
      if (err) {
        this.emit('error', err);
      }
      callback();
    });
  }

  return through.obj(Flow, function () {
    var end = () => {
      this.emit('end');
      passed = true;
    };

    if (passed) {
      console.log(logSymbols.success + ' Flow has found 0 errors');
    } else if (options.beep) {
      gutil.beep();
    }

    if (options.killFlow) {
      if (servers.length) {
        killServers().done(end);
      }
      else {
        end();
      }
    } else {
      end();
    }
  });
};
