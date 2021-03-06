(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.workerPouch = f()}})(function(){var define,module,exports;return (function(){function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s}return e})()({1:[function(_dereq_,module,exports){
'use strict';

var utils = _dereq_(8);
var clientUtils = _dereq_(5);
var uuid = _dereq_(9);
var errors = _dereq_(6);
var log = _dereq_(11)('pouchdb:worker:client');
var preprocessAttachments = clientUtils.preprocessAttachments;
var encodeArgs = clientUtils.encodeArgs;
var adapterFun = clientUtils.adapterFun;

// Implements the PouchDB API for dealing with PouchDB instances over WW
function WorkerPouch(opts, callback) {
  var api = this;

  if (typeof opts === 'string') {
    var slashIdx = utils.lastIndexOf(opts, '/');
    opts = {
      url: opts.substring(0, slashIdx),
      name: opts.substring(slashIdx + 1)
    };
  } else {
    opts = utils.clone(opts);
  }

  log('constructor called', opts);

  // Aspirational. once https://github.com/pouchdb/pouchdb/issues/5200
  // is resolved, you'll be able to directly pass in a worker here instead of
  // a function that returns a worker.
  var worker = (opts.worker && typeof opts.worker === 'function') ?
    opts.worker() : opts.worker;
  if (!worker || (!worker.postMessage && (!worker.controller || !worker.controller.postMessage))) {
    var workerOptsErrMessage =
      'Error: you must provide a valid `worker` in `new PouchDB()`';
    console.error(workerOptsErrMessage);
    return callback(new Error(workerOptsErrMessage));
  }

  if (!opts.name) {
    var optsErrMessage = 'Error: you must provide a database name.';
    console.error(optsErrMessage);
    return callback(new Error(optsErrMessage));
  }

  function handleUncaughtError(content) {
    try {
      api.emit('error', content);
    } catch (err) {
      // TODO: it's weird that adapters should have to handle this themselves
      console.error(
        'The user\'s map/reduce function threw an uncaught error.\n' +
        'You can debug this error by doing:\n' +
        'myDatabase.on(\'error\', function (err) { debugger; });\n' +
        'Please double-check your map/reduce function.');
      console.error(content);
    }
  }

  function onReceiveMessage(message) {
    var messageId = message.messageId;
    var messageType = message.type;
    var content = message.content;

    if (messageType === 'uncaughtError') {
      handleUncaughtError(content);
      return;
    }

    var cb = api._callbacks[messageId];

    if (!cb) {
      log('duplicate message (ignoring)', messageId, messageType, content);
      return;
    }

    log('receive message', api._instanceId, messageId, messageType, content);

    if (messageType === 'error') {
      delete api._callbacks[messageId];
      cb(content);
    } else if (messageType === 'success') {
      delete api._callbacks[messageId];
      cb(null, content);
    } else { // 'update'
      api._changesListeners[messageId](content);
    }
  }

  function workerListener(e) {
    if (e.data.id === api._instanceId) {
      onReceiveMessage(e.data);
    }
  }

  function postMessage(message) {
    /* istanbul ignore if */
    if (typeof worker.controller !== 'undefined') {
      // service worker, use MessageChannels because e.source is broken in Chrome < 51:
      // https://bugs.chromium.org/p/chromium/issues/detail?id=543198
      var channel = new MessageChannel();
      channel.port1.onmessage = workerListener;
      worker.controller.postMessage(message, [channel.port2]);
    } else {
      // web worker
      worker.postMessage(message);
    }
  }

  function sendMessage(type, args, callback) {
    if (api._destroyed) {
      return callback(new Error('this db was destroyed'));
    } else if (api._closed) {
      return callback(new Error('this db was closed'));
    }
    var messageId = uuid();
    log('send message', api._instanceId, messageId, type, args);
    api._callbacks[messageId] = callback;
    var encodedArgs = encodeArgs(args);
    postMessage({
      id: api._instanceId,
      type: type,
      messageId: messageId,
      args: encodedArgs
    });
    log('message sent', api._instanceId, messageId);
  }

  function sendRawMessage(messageId, type, args) {
    log('send message', api._instanceId, messageId, type, args);
    var encodedArgs = encodeArgs(args);
    postMessage({
      id: api._instanceId,
      type: type,
      messageId: messageId,
      args: encodedArgs
    });
    log('message sent', api._instanceId, messageId);
  }

  api.type = function () {
    return 'worker';
  };

  api._remote = false;

  api._id = adapterFun('id', function (callback) {
    sendMessage('id', [], callback);
  });

  api.compact = adapterFun('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('compact', [opts], callback);
  });

  api._info = function (callback) {
    sendMessage('info', [], callback);
  };

  api.get = adapterFun('get', function (id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('get', [id, opts], callback);
  });

  // hacky code necessary due to implicit breaking change in
  // https://github.com/pouchdb/pouchdb/commits/0ddeae6b
  api._get = function (id, opts, callback) {
    api.get(id, opts, function (err, doc) {
      if (err) {
        return callback(err);
      }
      callback(null, {doc: doc});
    });
  };

  api.remove =
    adapterFun('remove', function (docOrId, optsOrRev, opts, callback) {
      var doc;
      if (typeof optsOrRev === 'string') {
        // id, rev, opts, callback style
        doc = {
          _id: docOrId,
          _rev: optsOrRev
        };
        if (typeof opts === 'function') {
          callback = opts;
          opts = {};
        }
      } else {
        // doc, opts, callback style
        doc = docOrId;
        if (typeof optsOrRev === 'function') {
          callback = optsOrRev;
          opts = {};
        } else {
          callback = opts;
          opts = optsOrRev;
        }
      }
      var rev = (doc._rev || opts.rev);

      sendMessage('remove', [doc._id, rev], callback);
  });

  api.getAttachment =
    adapterFun('getAttachment', function (docId, attachmentId, opts,
                                                callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      sendMessage('getAttachment', [docId, attachmentId, opts], callback);
  });

  api.removeAttachment =
    adapterFun('removeAttachment', function (docId, attachmentId, rev,
                                                   callback) {

      sendMessage('removeAttachment', [docId, attachmentId, rev], callback);
    });

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment =
    adapterFun('putAttachment', function (docId, attachmentId, rev, blob,
                                                type, callback) {
      if (typeof type === 'function') {
        callback = type;
        type = blob;
        blob = rev;
        rev = null;
      }
      if (typeof type === 'undefined') {
        type = blob;
        blob = rev;
        rev = null;
      }

      if (typeof blob === 'string') {
        var binary;
        try {
          binary = atob(blob);
        } catch (err) {
          // it's not base64-encoded, so throw error
          return callback(errors.error(errors.BAD_ARG,
            'Attachments need to be base64 encoded'));
        }
        blob = utils.createBlob([utils.binaryStringToArrayBuffer(binary)], {type: type});
      }

      var args = [docId, attachmentId, rev, blob, type];
      sendMessage('putAttachment', args, callback);
    });

  api.put = adapterFun('put', utils.getArguments(function (args) {
    var temp, temptype, opts;
    var doc = args.shift();
    var id = '_id' in doc;
    var callback = args.pop();
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return callback(errors.error(errors.NOT_AN_OBJECT));
    }

    doc = utils.clone(doc);

    preprocessAttachments(doc).then(function () {
      while (true) {
        temp = args.shift();
        temptype = typeof temp;
        if (temptype === "string" && !id) {
          doc._id = temp;
          id = true;
        } else if (temptype === "string" && id && !('_rev' in doc)) {
          doc._rev = temp;
        } else if (temptype === "object") {
          opts = utils.clone(temp);
        }
        if (!args.length) {
          break;
        }
      }
      opts = opts || {};

      sendMessage('put', [doc, opts], callback);
    })["catch"](callback);

  }));

  api.post = adapterFun('post', function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = utils.clone(opts);

    sendMessage('post', [doc, opts], callback);
  });

  api._bulkDocs = function (req, opts, callback) {
    sendMessage('bulkDocs', [req, opts], callback);
  };

  api._allDocs = function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('allDocs', [opts], callback);
  };

  api._changes = function (opts) {
    opts = utils.clone(opts);

    if (opts.continuous) {
      var messageId = uuid();
      api._changesListeners[messageId] = opts.onChange;
      api._callbacks[messageId] = opts.complete;
      sendRawMessage(messageId, 'liveChanges', [opts]);
      return {
        cancel: function () {
          sendRawMessage(messageId, 'cancelChanges', []);
        }
      };
    }

    sendMessage('changes', [opts], function (err, res) {
      if (err) {
        opts.complete(err);
        return callback(err);
      }
      res.results.forEach(function (change) {
        opts.onChange(change);
      });
      if (opts.returnDocs === false || opts.return_docs === false) {
        res.results = [];
      }
      opts.complete(null, res);
    });
  };

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See http://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = adapterFun('revsDiff', function (req, opts, callback) {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    sendMessage('revsDiff', [req, opts], callback);
  });

  api._query = adapterFun('query', function (fun, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var funEncoded = fun;
    if (typeof fun === 'function') {
      funEncoded = {map: fun};
    }
    sendMessage('query', [funEncoded, opts], callback);
  });

  api._viewCleanup = adapterFun('viewCleanup', function (callback) {
    sendMessage('viewCleanup', [], callback);
  });

  api._close = function (callback) {
    api._closed = true;
    callback();
  };

  api.destroy = adapterFun('destroy', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('destroy', [], function (err, res) {
      if (err) {
        api.emit('error', err);
        return callback(err);
      }
      api._destroyed = true;
      worker.removeEventListener('message', workerListener);
      api.emit('destroyed');
      callback(null, res);
    });
  });

  // api.name was added in pouchdb 6.0.0
  api._instanceId = api.name || opts.originalName;
  api._callbacks = {};
  api._changesListeners = {};

  worker.addEventListener('message', workerListener);

  var workerOpts = {
    name: api._instanceId,
    auto_compaction: !!opts.auto_compaction,
    storage: opts.storage
  };
  if (opts.revs_limit) {
    workerOpts.revs_limit = opts.revs_limit;
  }

  sendMessage('createDatabase', [workerOpts], function (err) {
    if (err) {
      return callback(err);
    }
    callback(null, api);
  });
}

// WorkerPouch is a valid adapter.
WorkerPouch.valid = function () {
  return true;
};
WorkerPouch.use_prefix = false;

module.exports = WorkerPouch;

},{"11":11,"5":5,"6":6,"8":8,"9":9}],2:[function(_dereq_,module,exports){
'use strict';
/* global webkitURL */

module.exports = function createWorker(code) {
  var createBlob = _dereq_(8).createBlob;
  var URLCompat = typeof URL !== 'undefined' ? URL : webkitURL;

  function makeBlobURI(script) {
    var blob = createBlob([script], {type: 'text/javascript'});
    return URLCompat.createObjectURL(blob);
  }

  var blob = createBlob([code], {type: 'text/javascript'});
  return new Worker(makeBlobURI(blob));
};
},{"8":8}],3:[function(_dereq_,module,exports){
(function (global){
'use strict';

// main script used with a blob-style worker

var extend = _dereq_(15).extend;
var WorkerPouchCore = _dereq_(1);
var createWorker = _dereq_(2);
var isSupportedBrowser = _dereq_(4);
var workerCode = _dereq_(10);

function WorkerPouch(opts, callback) {

  var worker = window.__pouchdb_global_worker; // cache so there's only one
  if (!worker) {
    try {
      worker = createWorker(workerCode);
      worker.addEventListener('error', function (e) {
        if ('console' in global && 'warn' in console) {
          console.warn('worker threw an error', e.error);
        }
      });
      window.__pouchdb_global_worker = worker;
    } catch (e) {
      if ('console' in global && 'info' in console) {
        console.info('This browser is not supported by WorkerPouch. ' +
          'Please use isSupportedBrowser() to check.', e);
      }
      return callback(new Error('browser unsupported by worker-pouch'));
    }
  }

  var _opts = extend({
    worker: function () { return worker; }
  }, opts);

  WorkerPouchCore.call(this, _opts, callback);
}

WorkerPouch.valid = function () {
  return true;
};
WorkerPouch.use_prefix = false;

WorkerPouch.isSupportedBrowser = isSupportedBrowser;

module.exports = WorkerPouch;

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
  window.PouchDB.adapter('worker', module.exports);
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"1":1,"10":10,"15":15,"2":2,"4":4}],4:[function(_dereq_,module,exports){
(function (global){
'use strict';

function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var Promise = _interopDefault(_dereq_(18));
var createWorker = _dereq_(2);

module.exports = function isSupportedBrowser() {
  return Promise.resolve().then(function () {
    // synchronously throws in IE/Edge
    var worker = createWorker('' +
      'self.onmessage = function () {' +
      '  self.postMessage({' +
      '    hasIndexedDB: (typeof indexedDB !== "undefined")' +
      '  });' +
      '};');

    return new Promise(function (resolve, reject) {

      function listener(e) {
        worker.terminate();
        if (e.data.hasIndexedDB) {
          resolve();
          return;
        }
        reject();
      }

      function errorListener() {
        worker.terminate();
        reject();
      }

      worker.addEventListener('error', errorListener);
      worker.addEventListener('message', listener);
      worker.postMessage({});
    });
  }).then(function () {
    return true;
  }, function (err) {
    if ('console' in global && 'info' in console) {
      console.info('This browser is not supported by WorkerPouch', err);
    }
    return false;
  });
};
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"18":18,"2":2}],5:[function(_dereq_,module,exports){
(function (process){
'use strict';

var utils = _dereq_(8);
var log = _dereq_(11)('pouchdb:worker:client');
var isBrowser = typeof process === 'undefined' || process.browser;

exports.preprocessAttachments = function preprocessAttachments(doc) {
  if (!doc._attachments || !Object.keys(doc._attachments)) {
    return utils.Promise.resolve();
  }

  return utils.Promise.all(Object.keys(doc._attachments).map(function (key) {
    var attachment = doc._attachments[key];
    if (attachment.data && typeof attachment.data !== 'string') {
      if (isBrowser) {
        return new utils.Promise(function (resolve) {
          utils.readAsBinaryString(attachment.data, function (binary) {
            attachment.data = btoa(binary);
            resolve();
          });
        });
      } else {
        attachment.data = attachment.data.toString('base64');
      }
    }
  }));
};

function encodeObjectArg(arg) {
  // these can't be encoded by normal structured cloning
  var funcKeys = ['filter', 'map', 'reduce'];
  var keysToRemove = ['onChange', 'processChange', 'complete'];
  var clonedArg = {};
  Object.keys(arg).forEach(function (key) {
    if (keysToRemove.indexOf(key) !== -1) {
      return;
    }
    if (funcKeys.indexOf(key) !== -1 && typeof arg[key] === 'function') {
      clonedArg[key] = {
        type: 'func',
        func: arg[key].toString()
      };
    } else {
      clonedArg[key] = arg[key];
    }
  });
  return clonedArg;
}

exports.encodeArgs = function encodeArgs(args) {
  var result = [];
  args.forEach(function (arg) {
    if (arg === null || typeof arg !== 'object' ||
        Array.isArray(arg) || arg instanceof Blob || arg instanceof Date) {
      result.push(arg);
    } else {
      result.push(encodeObjectArg(arg));
    }
  });
  return result;
};

exports.padInt = function padInt(i, len) {
  var res = i.toString();
  while (res.length < len) {
    res = '0' + res;
  }
  return res;
};


exports.adapterFun = function adapterFun(name, callback) {

  function logApiCall(self, name, args) {
    if (!log.enabled) {
      return;
    }
    // db.name was added in pouch 6.0.0
    var dbName = self.name || self._db_name;
    var logArgs = [dbName, name];
    for (var i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    log.apply(null, logArgs);

    // override the callback itself to log the response
    var origCallback = args[args.length - 1];
    args[args.length - 1] = function (err, res) {
      var responseArgs = [dbName, name];
      responseArgs = responseArgs.concat(
        err ? ['error', err] : ['success', res]
      );
      log.apply(null, responseArgs);
      origCallback(err, res);
    };
  }


  return utils.toPromise(utils.getArguments(function (args) {
    if (this._closed) {
      return utils.Promise.reject(new Error('database is closed'));
    }
    var self = this;
    logApiCall(self, name, args);
    if (!this.taskqueue.isReady) {
      return new utils.Promise(function (fulfill, reject) {
        self.taskqueue.addTask(function (failed) {
          if (failed) {
            reject(failed);
          } else {
            fulfill(self[name].apply(self, args));
          }
        });
      });
    }
    return callback.apply(this, args);
  }));
};
}).call(this,_dereq_(20))
},{"11":11,"20":20,"8":8}],6:[function(_dereq_,module,exports){
"use strict";

var inherits = _dereq_(14);
inherits(PouchError, Error);

function PouchError(opts) {
  Error.call(opts.reason);
  this.status = opts.status;
  this.name = opts.error;
  this.message = opts.reason;
  this.error = true;
}

PouchError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message
  });
};

exports.UNAUTHORIZED = new PouchError({
  status: 401,
  error: 'unauthorized',
  reason: "Name or password is incorrect."
});

exports.MISSING_BULK_DOCS = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: "Missing JSON list of 'docs'"
});

exports.MISSING_DOC = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'missing'
});

exports.REV_CONFLICT = new PouchError({
  status: 409,
  error: 'conflict',
  reason: 'Document update conflict'
});

exports.INVALID_ID = new PouchError({
  status: 400,
  error: 'invalid_id',
  reason: '_id field must contain a string'
});

exports.MISSING_ID = new PouchError({
  status: 412,
  error: 'missing_id',
  reason: '_id is required for puts'
});

exports.RESERVED_ID = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Only reserved document ids may start with underscore.'
});

exports.NOT_OPEN = new PouchError({
  status: 412,
  error: 'precondition_failed',
  reason: 'Database not open'
});

exports.UNKNOWN_ERROR = new PouchError({
  status: 500,
  error: 'unknown_error',
  reason: 'Database encountered an unknown error'
});

exports.BAD_ARG = new PouchError({
  status: 500,
  error: 'badarg',
  reason: 'Some query argument is invalid'
});

exports.INVALID_REQUEST = new PouchError({
  status: 400,
  error: 'invalid_request',
  reason: 'Request was invalid'
});

exports.QUERY_PARSE_ERROR = new PouchError({
  status: 400,
  error: 'query_parse_error',
  reason: 'Some query parameter is invalid'
});

exports.DOC_VALIDATION = new PouchError({
  status: 500,
  error: 'doc_validation',
  reason: 'Bad special document member'
});

exports.BAD_REQUEST = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Something wrong with the request'
});

exports.NOT_AN_OBJECT = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Document must be a JSON object'
});

exports.DB_MISSING = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'Database not found'
});

exports.IDB_ERROR = new PouchError({
  status: 500,
  error: 'indexed_db_went_bad',
  reason: 'unknown'
});

exports.WSQ_ERROR = new PouchError({
  status: 500,
  error: 'web_sql_went_bad',
  reason: 'unknown'
});

exports.LDB_ERROR = new PouchError({
  status: 500,
  error: 'levelDB_went_went_bad',
  reason: 'unknown'
});

exports.FORBIDDEN = new PouchError({
  status: 403,
  error: 'forbidden',
  reason: 'Forbidden by design doc validate_doc_update function'
});

exports.INVALID_REV = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Invalid rev format'
});

exports.FILE_EXISTS = new PouchError({
  status: 412,
  error: 'file_exists',
  reason: 'The database could not be created, the file already exists.'
});

exports.MISSING_STUB = new PouchError({
  status: 412,
  error: 'missing_stub'
});

exports.error = function (error, reason, name) {
  function CustomPouchError(reason) {
    // inherit error properties from our parent error manually
    // so as to allow proper JSON parsing.
    /* jshint ignore:start */
    for (var p in error) {
      if (typeof error[p] !== 'function') {
        this[p] = error[p];
      }
    }
    /* jshint ignore:end */
    if (name !== undefined) {
      this.name = name;
    }
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
  CustomPouchError.prototype = PouchError.prototype;
  return new CustomPouchError(reason);
};

// Find one of the errors defined above based on the value
// of the specified property.
// If reason is provided prefer the error matching that reason.
// This is for differentiating between errors with the same name and status,
// eg, bad_request.
exports.getErrorTypeByProp = function (prop, value, reason) {
  var errors = exports;
  var keys = Object.keys(errors).filter(function (key) {
    var error = errors[key];
    return typeof error !== 'function' && error[prop] === value;
  });
  var key = reason && keys.filter(function (key) {
      var error = errors[key];
      return error.message === reason;
    })[0] || keys[0];
  return (key) ? errors[key] : null;
};

exports.generateErrorFromResponse = function (res) {
  var error, errName, errType, errMsg, errReason;
  var errors = exports;

  errName = (res.error === true && typeof res.name === 'string') ?
    res.name :
    res.error;
  errReason = res.reason;
  errType = errors.getErrorTypeByProp('name', errName, errReason);

  if (res.missing ||
    errReason === 'missing' ||
    errReason === 'deleted' ||
    errName === 'not_found') {
    errType = errors.MISSING_DOC;
  } else if (errName === 'doc_validation') {
    // doc validation needs special treatment since
    // res.reason depends on the validation error.
    // see utils.js
    errType = errors.DOC_VALIDATION;
    errMsg = errReason;
  } else if (errName === 'bad_request' && errType.message !== errReason) {
    // if bad_request error already found based on reason don't override.

    // attachment errors.
    if (errReason.indexOf('unknown stub attachment') === 0) {
      errType = errors.MISSING_STUB;
      errMsg = errReason;
    } else {
      errType = errors.BAD_REQUEST;
    }
  }

  // fallback to error by statys or unknown error.
  if (!errType) {
    errType = errors.getErrorTypeByProp('status', res.status, errReason) ||
    errors.UNKNOWN_ERROR;
  }

  error = errors.error(errType, errReason, errName);

  // Keep custom message.
  if (errMsg) {
    error.message = errMsg;
  }

  // Keep helpful response data in our error messages.
  if (res.id) {
    error.id = res.id;
  }
  if (res.status) {
    error.status = res.status;
  }
  if (res.statusText) {
    error.name = res.statusText;
  }
  if (res.missing) {
    error.missing = res.missing;
  }

  return error;
};

},{"14":14}],7:[function(_dereq_,module,exports){
'use strict';

function isBinaryObject(object) {
  return object instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && object instanceof Blob);
}

function cloneArrayBuffer(buff) {
  if (typeof buff.slice === 'function') {
    return buff.slice(0);
  }
  // IE10-11 slice() polyfill
  var target = new ArrayBuffer(buff.byteLength);
  var targetArray = new Uint8Array(target);
  var sourceArray = new Uint8Array(buff);
  targetArray.set(sourceArray);
  return target;
}

function cloneBinaryObject(object) {
  if (object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object);
  }
  // Blob
  return object.slice(0, object.size, object.type);
}

module.exports = function clone(object) {
  var newObject;
  var i;
  var len;

  if (!object || typeof object !== 'object') {
    return object;
  }

  if (Array.isArray(object)) {
    newObject = [];
    for (i = 0, len = object.length; i < len; i++) {
      newObject[i] = clone(object[i]);
    }
    return newObject;
  }

  // special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date) {
    return object.toISOString();
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object);
  }

  newObject = {};
  for (i in object) {
    if (Object.prototype.hasOwnProperty.call(object, i)) {
      var value = clone(object[i]);
      if (typeof value !== 'undefined') {
        newObject[i] = value;
      }
    }
  }
  return newObject;
};

},{}],8:[function(_dereq_,module,exports){
(function (process,global){
'use strict';

function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var Promise = _interopDefault(_dereq_(18));

exports.lastIndexOf = function lastIndexOf(str, char) {
  for (var i = str.length - 1; i >= 0; i--) {
    if (str.charAt(i) === char) {
      return i;
    }
  }
  return -1;
};

exports.clone = _dereq_(7);

/* istanbul ignore next */
exports.once = function once(fun) {
  var called = false;
  return exports.getArguments(function (args) {
    if (called) {
      if ('console' in global && 'trace' in console) {
        console.trace();
      }
      throw new Error('once called  more than once');
    } else {
      called = true;
      fun.apply(this, args);
    }
  });
};
/* istanbul ignore next */
exports.getArguments = function getArguments(fun) {
  return function () {
    var len = arguments.length;
    var args = new Array(len);
    var i = -1;
    while (++i < len) {
      args[i] = arguments[i];
    }
    return fun.call(this, args);
  };
};
/* istanbul ignore next */
exports.toPromise = function toPromise(func) {
  //create the function we will be returning
  return exports.getArguments(function (args) {
    var self = this;
    var tempCB = (typeof args[args.length - 1] === 'function') ? args.pop() : false;
    // if the last argument is a function, assume its a callback
    var usedCB;
    if (tempCB) {
      // if it was a callback, create a new callback which calls it,
      // but do so async so we don't trap any errors
      usedCB = function (err, resp) {
        process.nextTick(function () {
          tempCB(err, resp);
        });
      };
    }
    var promise = new Promise(function (fulfill, reject) {
      try {
        var callback = exports.once(function (err, mesg) {
          if (err) {
            reject(err);
          } else {
            fulfill(mesg);
          }
        });
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback);
        func.apply(self, args);
      } catch (e) {
        reject(e);
      }
    });
    // if there is a callback, call it back
    if (usedCB) {
      promise.then(function (result) {
        usedCB(null, result);
      }, usedCB);
    }
    promise.cancel = function () {
      return this;
    };
    return promise;
  });
};

exports.inherits = _dereq_(14);
exports.Promise = Promise;

var binUtil = _dereq_(17);

exports.createBlob = binUtil.createBlob;
exports.readAsArrayBuffer = binUtil.readAsArrayBuffer;
exports.readAsBinaryString = binUtil.readAsBinaryString;
exports.binaryStringToArrayBuffer = binUtil.binaryStringToArrayBuffer;
exports.arrayBufferToBinaryString = binUtil.arrayBufferToBinaryString;

}).call(this,_dereq_(20),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"14":14,"17":17,"18":18,"20":20,"7":7}],9:[function(_dereq_,module,exports){
"use strict";

// BEGIN Math.uuid.js

/*!
 Math.uuid.js (v1.4)
 http://www.broofa.com
 mailto:robert@broofa.com

 Copyright (c) 2010 Robert Kieffer
 Dual licensed under the MIT and GPL licenses.
 */

/*
 * Generate a random uuid.
 *
 * USAGE: Math.uuid(length, radix)
 *   length - the desired number of characters
 *   radix  - the number of allowable values for each character.
 *
 * EXAMPLES:
 *   // No arguments  - returns RFC4122, version 4 ID
 *   >>> Math.uuid()
 *   "92329D39-6F5C-4520-ABFC-AAB64544E172"
 *
 *   // One argument - returns ID of the specified length
 *   >>> Math.uuid(15)     // 15 character ID (default base=62)
 *   "VcydxgltxrVZSTV"
 *
 *   // Two arguments - returns ID of the specified length, and radix. 
 *   // (Radix must be <= 62)
 *   >>> Math.uuid(8, 2)  // 8 character ID (base=2)
 *   "01001010"
 *   >>> Math.uuid(8, 10) // 8 character ID (base=10)
 *   "47473046"
 *   >>> Math.uuid(8, 16) // 8 character ID (base=16)
 *   "098F4D35"
 */
var chars = (
'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
'abcdefghijklmnopqrstuvwxyz'
).split('');
function getValue(radix) {
  return 0 | Math.random() * radix;
}
function uuid(len, radix) {
  radix = radix || chars.length;
  var out = '';
  var i = -1;

  if (len) {
    // Compact form
    while (++i < len) {
      out += chars[getValue(radix)];
    }
    return out;
  }
  // rfc4122, version 4 form
  // Fill in random data.  At i==19 set the high bits of clock sequence as
  // per rfc4122, sec. 4.1.5
  while (++i < 36) {
    switch (i) {
      case 8:
      case 13:
      case 18:
      case 23:
        out += '-';
        break;
      case 19:
        out += chars[(getValue(16) & 0x3) | 0x8];
        break;
      default:
        out += chars[getValue(16)];
    }
  }

  return out;
}



module.exports = uuid;


},{}],10:[function(_dereq_,module,exports){
// this code is automatically generated by bin/build.js
module.exports = "!function(){function e(t,n,r){function o(s,a){if(!n[s]){if(!t[s]){var c=\"function\"==typeof require&&require;if(!a&&c)return c(s,!0);if(i)return i(s,!0);var u=new Error(\"Cannot find module '\"+s+\"'\");throw u.code=\"MODULE_NOT_FOUND\",u}var f=n[s]={exports:{}};t[s][0].call(f.exports,function(e){var n=t[s][1][e];return o(n||e)},f,f.exports,e,t,n,r)}return n[s].exports}for(var i=\"function\"==typeof require&&require,s=0;s<r.length;s++)o(r[s]);return o}return e}()({1:[function(e,t,n){\"use strict\";function r(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}e(12)(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},n.UNAUTHORIZED=new r({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),n.MISSING_BULK_DOCS=new r({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),n.MISSING_DOC=new r({status:404,error:\"not_found\",reason:\"missing\"}),n.REV_CONFLICT=new r({status:409,error:\"conflict\",reason:\"Document update conflict\"}),n.INVALID_ID=new r({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),n.MISSING_ID=new r({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),n.RESERVED_ID=new r({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),n.NOT_OPEN=new r({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),n.UNKNOWN_ERROR=new r({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),n.BAD_ARG=new r({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),n.INVALID_REQUEST=new r({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),n.QUERY_PARSE_ERROR=new r({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),n.DOC_VALIDATION=new r({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),n.BAD_REQUEST=new r({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),n.NOT_AN_OBJECT=new r({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),n.DB_MISSING=new r({status:404,error:\"not_found\",reason:\"Database not found\"}),n.IDB_ERROR=new r({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),n.WSQ_ERROR=new r({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),n.LDB_ERROR=new r({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),n.FORBIDDEN=new r({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),n.INVALID_REV=new r({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),n.FILE_EXISTS=new r({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),n.MISSING_STUB=new r({status:412,error:\"missing_stub\"}),n.error=function(e,t,n){function o(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return o.prototype=r.prototype,new o(t)},n.getErrorTypeByProp=function(e,t,r){var o=n,i=Object.keys(o).filter(function(n){var r=o[n];return\"function\"!=typeof r&&r[e]===t}),s=r&&i.filter(function(e){return o[e].message===r})[0]||i[0];return s?o[s]:null},n.generateErrorFromResponse=function(e){var t,r,o,i,s,a=n;return r=!0===e.error&&\"string\"==typeof e.name?e.name:e.error,s=e.reason,o=a.getErrorTypeByProp(\"name\",r,s),e.missing||\"missing\"===s||\"deleted\"===s||\"not_found\"===r?o=a.MISSING_DOC:\"doc_validation\"===r?(o=a.DOC_VALIDATION,i=s):\"bad_request\"===r&&o.message!==s&&(0===s.indexOf(\"unknown stub attachment\")?(o=a.MISSING_STUB,i=s):o=a.BAD_REQUEST),o||(o=a.getErrorTypeByProp(\"status\",e.status,s)||a.UNKNOWN_ERROR),t=a.error(o,s,r),i&&(t.message=i),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{12:12}],2:[function(e,t,n){\"use strict\";function r(e,t){function n(t,n){\"function\"!=typeof e.postMessage?n.ports[0].postMessage(t):e.postMessage(t)}function r(e,t,r){f(\" -> sendUncaughtError\",e,t),n({type:\"uncaughtError\",id:e,content:s.createError(t)},r)}function l(e,t,r,o){f(\" -> sendError\",e,t,r),n({type:\"error\",id:e,messageId:t,content:s.createError(r)},o)}function d(e,t,r,o){f(\" -> sendSuccess\",e,t),n({type:\"success\",id:e,messageId:t,content:r},o)}function h(e,t,r,o){f(\" -> sendUpdate\",e,t),n({type:\"update\",id:e,messageId:t,content:r},o)}function p(e,t,n,r,i){var s=c[\"$\"+e];if(!s)return l(e,n,{error:\"db not found\"},i);o.resolve().then(function(){return s[t].apply(s,r)}).then(function(t){d(e,n,t,i)}).catch(function(t){l(e,n,t,i)})}function v(e,t,n,r){var o=n[0];o&&\"object\"==typeof o&&(o.returnDocs=!0,o.return_docs=!0),p(e,\"changes\",t,n,r)}function _(e,t,n,r){var s=c[\"$\"+e];if(!s)return l(e,t,{error:\"db not found\"},r);o.resolve().then(function(){var o=n[0],a=n[1],c=n[2];return\"object\"!=typeof c&&(c={}),s.get(o,c).then(function(o){if(!o._attachments||!o._attachments[a])throw i.MISSING_DOC;return s.getAttachment.apply(s,n).then(function(n){d(e,t,n,r)})})}).catch(function(n){l(e,t,n,r)})}function g(e,t,n,r){var i=\"$\"+e,s=c[i];if(!s)return l(e,t,{error:\"db not found\"},r);delete c[i],o.resolve().then(function(){return s.destroy.apply(s,n)}).then(function(n){d(e,t,n,r)}).catch(function(n){l(e,t,n,r)})}function y(e,t,n,r){var i=c[\"$\"+e];if(!i)return l(e,t,{error:\"db not found\"},r);o.resolve().then(function(){var o=i.changes(n[0]);u[t]=o,o.on(\"change\",function(n){h(e,t,n,r)}).on(\"complete\",function(n){o.removeAllListeners(),delete u[t],d(e,t,n,r)}).on(\"error\",function(n){o.removeAllListeners(),delete u[t],l(e,t,n,r)})})}function m(e){var t=u[e];t&&t.cancel()}function b(e,t,n){return o.resolve().then(function(){e.on(\"error\",function(e){r(t,e,n)})})}function w(e,n,r,o){var i=\"$\"+e,s=c[i];return s?b(s,e,o).then(function(){return d(e,n,{ok:!0,exists:!0},o)}):(\"string\"==typeof r[0]?r[0]:r[0].name)?(s=c[i]=t(r[0]),void b(s,e,o).then(function(){d(e,n,{ok:!0},o)}).catch(function(t){l(e,n,t,o)})):l(e,n,{error:\"you must provide a database name\"},o)}function k(e,t,n,r,o){switch(f(\"onReceiveMessage\",t,e,n,r,o),t){case\"createDatabase\":return w(e,n,r,o);case\"id\":case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":return p(e,t,n,r,o);case\"changes\":return v(e,n,r,o);case\"getAttachment\":return _(e,n,r,o);case\"liveChanges\":return y(e,n,r,o);case\"cancelChanges\":return m(n);case\"destroy\":return g(e,n,r,o);default:return l(e,n,{error:\"unknown API method: \"+t},o)}}function E(e,t,n){k(t,e.type,e.messageId,a(e.args),n)}e.addEventListener(\"message\",function(e){if(e.data&&e.data.id&&e.data.args&&e.data.type&&e.data.messageId){var t=e.data.id;\"close\"===e.data.type?(f(\"closing worker\",t),delete c[\"$\"+t]):E(e.data,t,e)}})}var o=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(32)),i=e(1),s=e(6),a=s.decodeArgs,c={},u={},f=e(8)(\"pouchdb:worker\");t.exports=r},{1:1,32:32,6:6,8:8}],3:[function(e,t,n){\"use strict\";var r=e(2),o=e(4);r(self,o)},{2:2,4:4}],4:[function(e,t,n){\"use strict\";t.exports=e(23).plugin(e(16)).plugin(e(15)).plugin(e(29)).plugin(e(34))},{15:15,16:16,23:23,29:29,34:34}],5:[function(_dereq_,module,exports){\"use strict\";var log=_dereq_(8)(\"pouchdb:worker\");module.exports=function safeEval(str){log(\"safeEvaling\",str);var target={};return eval(\"target.target = (\"+str+\");\"),log(\"returning\",target.target),target.target}},{8:8}],6:[function(e,t,n){\"use strict\";var r=e(5);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){var t=[\"filter\",\"map\",\"reduce\"];return e.forEach(function(e){\"object\"!=typeof e||null===e||Array.isArray(e)||t.forEach(function(t){t in e&&null!==e[t]?\"func\"===e[t].type&&e[t].func&&(e[t]=r(e[t].func)):delete e[t]})}),e}},{5:5}],7:[function(e,t,n){\"use strict\";function r(e){return function(){var t=arguments.length;if(t){for(var n=[],r=-1;++r<t;)n[r]=arguments[r];return e.call(this,n)}return e.call(this,[])}}t.exports=r},{}],8:[function(e,t,n){(function(r){function o(){return!(\"undefined\"==typeof window||!window.process||\"renderer\"!==window.process.type)||(\"undefined\"!=typeof document&&document.documentElement&&document.documentElement.style&&document.documentElement.style.WebkitAppearance||\"undefined\"!=typeof window&&window.console&&(window.console.firebug||window.console.exception&&window.console.table)||\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31||\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/applewebkit\\/(\\d+)/))}function i(e){var t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),t){var r=\"color: \"+this.color;e.splice(1,0,r,\"color: inherit\");var o=0,i=0;e[0].replace(/%[a-zA-Z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r)}}function s(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function a(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function c(){var e;try{e=n.storage.debug}catch(e){}return!e&&void 0!==r&&\"env\"in r&&(e=r.env.DEBUG),e}n=t.exports=e(9),n.log=s,n.formatArgs=i,n.save=a,n.load=c,n.useColors=o,n.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){try{return JSON.stringify(e)}catch(e){return\"[UnexpectedJSONParseError]: \"+e.message}},n.enable(c())}).call(this,e(37))},{37:37,9:9}],9:[function(e,t,n){function r(e){var t,r=0;for(t in e)r=(r<<5)-r+e.charCodeAt(t),r|=0;return n.colors[Math.abs(r)%n.colors.length]}function o(e){function t(){if(t.enabled){var e=t,r=+new Date,o=r-(u||r);e.diff=o,e.prev=u,e.curr=r,u=r;for(var i=new Array(arguments.length),s=0;s<i.length;s++)i[s]=arguments[s];i[0]=n.coerce(i[0]),\"string\"!=typeof i[0]&&i.unshift(\"%O\");var a=0;i[0]=i[0].replace(/%([a-zA-Z%])/g,function(t,r){if(\"%%\"===t)return t;a++;var o=n.formatters[r];if(\"function\"==typeof o){var s=i[a];t=o.call(e,s),i.splice(a,1),a--}return t}),n.formatArgs.call(e,i);(t.log||n.log||console.log.bind(console)).apply(e,i)}}return t.namespace=e,t.enabled=n.enabled(e),t.useColors=n.useColors(),t.color=r(e),\"function\"==typeof n.init&&n.init(t),t}function i(e){n.save(e),n.names=[],n.skips=[];for(var t=(\"string\"==typeof e?e:\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function s(){n.enable(\"\")}function a(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function c(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o.debug=o.default=o,n.coerce=c,n.disable=s,n.enable=i,n.enabled=a,n.humanize=e(13),n.names=[],n.skips=[],n.formatters={};var u},{13:13}],10:[function(e,t,n){function r(){this._events=this._events||{},this._maxListeners=this._maxListeners||void 0}function o(e){return\"function\"==typeof e}function i(e){return\"number\"==typeof e}function s(e){return\"object\"==typeof e&&null!==e}function a(e){return void 0===e}t.exports=r,r.EventEmitter=r,r.prototype._events=void 0,r.prototype._maxListeners=void 0,r.defaultMaxListeners=10,r.prototype.setMaxListeners=function(e){if(!i(e)||e<0||isNaN(e))throw TypeError(\"n must be a positive number\");return this._maxListeners=e,this},r.prototype.emit=function(e){var t,n,r,i,c,u;if(this._events||(this._events={}),\"error\"===e&&(!this._events.error||s(this._events.error)&&!this._events.error.length)){if((t=arguments[1])instanceof Error)throw t;var f=new Error('Uncaught, unspecified \"error\" event. ('+t+\")\");throw f.context=t,f}if(n=this._events[e],a(n))return!1;if(o(n))switch(arguments.length){case 1:n.call(this);break;case 2:n.call(this,arguments[1]);break;case 3:n.call(this,arguments[1],arguments[2]);break;default:i=Array.prototype.slice.call(arguments,1),n.apply(this,i)}else if(s(n))for(i=Array.prototype.slice.call(arguments,1),u=n.slice(),r=u.length,c=0;c<r;c++)u[c].apply(this,i);return!0},r.prototype.addListener=function(e,t){var n;if(!o(t))throw TypeError(\"listener must be a function\");return this._events||(this._events={}),this._events.newListener&&this.emit(\"newListener\",e,o(t.listener)?t.listener:t),this._events[e]?s(this._events[e])?this._events[e].push(t):this._events[e]=[this._events[e],t]:this._events[e]=t,s(this._events[e])&&!this._events[e].warned&&(n=a(this._maxListeners)?r.defaultMaxListeners:this._maxListeners)&&n>0&&this._events[e].length>n&&(this._events[e].warned=!0,console.error(\"(node) warning: possible EventEmitter memory leak detected. %d listeners added. Use emitter.setMaxListeners() to increase limit.\",this._events[e].length),\"function\"==typeof console.trace&&console.trace()),this},r.prototype.on=r.prototype.addListener,r.prototype.once=function(e,t){function n(){this.removeListener(e,n),r||(r=!0,t.apply(this,arguments))}if(!o(t))throw TypeError(\"listener must be a function\");var r=!1;return n.listener=t,this.on(e,n),this},r.prototype.removeListener=function(e,t){var n,r,i,a;if(!o(t))throw TypeError(\"listener must be a function\");if(!this._events||!this._events[e])return this;if(n=this._events[e],i=n.length,r=-1,n===t||o(n.listener)&&n.listener===t)delete this._events[e],this._events.removeListener&&this.emit(\"removeListener\",e,t);else if(s(n)){for(a=i;a-- >0;)if(n[a]===t||n[a].listener&&n[a].listener===t){r=a;break}if(r<0)return this;1===n.length?(n.length=0,delete this._events[e]):n.splice(r,1),this._events.removeListener&&this.emit(\"removeListener\",e,t)}return this},r.prototype.removeAllListeners=function(e){var t,n;if(!this._events)return this;if(!this._events.removeListener)return 0===arguments.length?this._events={}:this._events[e]&&delete this._events[e],this;if(0===arguments.length){for(t in this._events)\"removeListener\"!==t&&this.removeAllListeners(t);return this.removeAllListeners(\"removeListener\"),this._events={},this}if(n=this._events[e],o(n))this.removeListener(e,n);else if(n)for(;n.length;)this.removeListener(e,n[n.length-1]);return delete this._events[e],this},r.prototype.listeners=function(e){return this._events&&this._events[e]?o(this._events[e])?[this._events[e]]:this._events[e].slice():[]},r.prototype.listenerCount=function(e){if(this._events){var t=this._events[e];if(o(t))return 1;if(t)return t.length}return 0},r.listenerCount=function(e,t){return e.listenerCount(t)}},{}],11:[function(e,t,n){(function(e){\"use strict\";function n(){f=!0;for(var e,t,n=l.length;n;){for(t=l,l=[],e=-1;++e<n;)t[e]();n=l.length}f=!1}function r(e){1!==l.push(e)||f||o()}var o,i=e.MutationObserver||e.WebKitMutationObserver;if(i){var s=0,a=new i(n),c=e.document.createTextNode(\"\");a.observe(c,{characterData:!0}),o=function(){c.data=s=++s%2}}else if(e.setImmediate||void 0===e.MessageChannel)o=\"document\"in e&&\"onreadystatechange\"in e.document.createElement(\"script\")?function(){var t=e.document.createElement(\"script\");t.onreadystatechange=function(){n(),t.onreadystatechange=null,t.parentNode.removeChild(t),t=null},e.document.documentElement.appendChild(t)}:function(){setTimeout(n,0)};else{var u=new e.MessageChannel;u.port1.onmessage=n,o=function(){u.port2.postMessage(0)}}var f,l=[];t.exports=r}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],12:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;var n=function(){};n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],13:[function(e,t,n){function r(e){if(e=String(e),!(e.length>100)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*u;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*c;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*a;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n;default:return}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=u?Math.round(e/u)+\"h\":e>=c?Math.round(e/c)+\"m\":e>=a?Math.round(e/a)+\"s\":e+\"ms\"}function i(e){return s(e,f,\"day\")||s(e,u,\"hour\")||s(e,c,\"minute\")||s(e,a,\"second\")||e+\" ms\"}function s(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var a=1e3,c=60*a,u=60*c,f=24*u,l=365.25*f;t.exports=function(e,t){t=t||{};var n=typeof e;if(\"string\"===n&&e.length>0)return r(e);if(\"number\"===n&&!1===isNaN(e))return t.long?i(e):o(e);throw new Error(\"val is not a non-empty string or a valid number. val=\"+JSON.stringify(e))}},{}],14:[function(e,t,n){\"use strict\";function r(){this.promise=new Promise(function(e){e()})}function o(e){if(!e)return\"undefined\";switch(typeof e){case\"function\":case\"string\":return e.toString();default:return JSON.stringify(e)}}function i(e,t){return o(e)+o(t)+\"undefined\"}function s(e,t,n,r,o,s){var a,c=i(n,r);if(!o&&(a=e._cachedViews=e._cachedViews||{},a[c]))return a[c];var u=e.info().then(function(i){function u(e){e.views=e.views||{};var n=t;-1===n.indexOf(\"/\")&&(n=t+\"/\"+t);var r=e.views[n]=e.views[n]||{};if(!r[f])return r[f]=!0,e}var f=i.db_name+\"-mrview-\"+(o?\"temp\":d.stringMd5(c));return l.upsert(e,\"_local/\"+s,u).then(function(){return e.registerDependentDatabase(f).then(function(t){var o=t.db;o.auto_compaction=!0;var i={name:f,db:o,sourceDB:e,adapter:e.adapter,mapFun:n,reduceFun:r};return i.db.get(\"_local/lastSeq\").catch(function(e){if(404!==e.status)throw e}).then(function(e){return i.seq=e?e.seq:0,a&&i.db.once(\"destroyed\",function(){delete a[c]}),i})})})});return a&&(a[c]=u),u}function a(e){return-1===e.indexOf(\"/\")?[e,e]:e.split(\"/\")}function c(e){return 1===e.length&&/^1-/.test(e[0].rev)}function u(e,t){try{e.emit(\"error\",t)}catch(e){l.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),l.guardedConsole(\"error\",t)}}function f(e,t,n,o){function i(e,t,n){try{t(n)}catch(t){u(e,t)}}function f(e,t,n,r,o){try{return{output:t(n,r,o)}}catch(t){return u(e,t),{error:t}}}function d(e,t){var n=v.collate(e.key,t.key);return 0!==n?n:v.collate(e.value,t.value)}function k(e,t,n){return n=n||0,\"number\"==typeof t?e.slice(n,t+n):n>0?e.slice(n):e}function E(e){var t=e.value;return t&&\"object\"==typeof t&&t._id||e.id}function S(e){e.rows.forEach(function(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];t[e].data=p.base64StringToBlobOrBuffer(n.data,n.content_type)})})}function O(e){return function(t){return e.include_docs&&e.attachments&&e.binary&&S(t),t}}function A(e,t,n,r){var o=t[e];void 0!==o&&(r&&(o=encodeURIComponent(JSON.stringify(o))),n.push(e+\"=\"+o))}function I(e){if(void 0!==e){var t=Number(e);return isNaN(t)||t!==parseInt(e,10)?e:t}}function j(e){return e.group_level=I(e.group_level),e.limit=I(e.limit),e.skip=I(e.skip),e}function D(e){if(e){if(\"number\"!=typeof e)return new y.QueryParseError('Invalid value for integer: \"'+e+'\"');if(e<0)return new y.QueryParseError('Invalid value for positive integer: \"'+e+'\"')}}function q(e,t){var n=e.descending?\"endkey\":\"startkey\",r=e.descending?\"startkey\":\"endkey\";if(void 0!==e[n]&&void 0!==e[r]&&v.collate(e[n],e[r])>0)throw new y.QueryParseError(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(t.reduce&&!1!==e.reduce){if(e.include_docs)throw new y.QueryParseError(\"{include_docs:true} is invalid for reduce\");if(e.keys&&e.keys.length>1&&!e.group&&!e.group_level)throw new y.QueryParseError(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(t){var n=D(e[t]);if(n)throw n})}function x(e,t,n){var r,o,i,s=[],c=\"GET\";if(A(\"reduce\",n,s),A(\"include_docs\",n,s),A(\"attachments\",n,s),A(\"limit\",n,s),A(\"descending\",n,s),A(\"group\",n,s),A(\"group_level\",n,s),A(\"skip\",n,s),A(\"stale\",n,s),A(\"conflicts\",n,s),A(\"startkey\",n,s,!0),A(\"start_key\",n,s,!0),A(\"endkey\",n,s,!0),A(\"end_key\",n,s,!0),A(\"inclusive_end\",n,s),A(\"key\",n,s,!0),A(\"update_seq\",n,s),s=s.join(\"&\"),s=\"\"===s?\"\":\"?\"+s,void 0!==n.keys){var u=\"keys=\"+encodeURIComponent(JSON.stringify(n.keys));u.length+s.length+1<=2e3?s+=(\"?\"===s[0]?\"&\":\"?\")+u:(c=\"POST\",\"string\"==typeof t?r={keys:n.keys}:t.keys=n.keys)}if(\"string\"==typeof t){var f=a(t);return e.fetch(\"_design/\"+f[0]+\"/_view/\"+f[1]+s,{headers:new g.Headers({\"Content-Type\":\"application/json\"}),method:c,body:JSON.stringify(r)}).then(function(e){return o=e.ok,i=e.status,e.json()}).then(function(e){if(!o)throw e.status=i,_.generateErrorFromResponse(e);return e.rows.forEach(function(e){if(e.value&&e.value.error&&\"builtin_reduce_error\"===e.value.error)throw new Error(e.reason)}),e}).then(O(n))}return r=r||{},Object.keys(t).forEach(function(e){Array.isArray(t[e])?r[e]=t[e]:r[e]=t[e].toString()}),e.fetch(\"_temp_view\"+s,{headers:new g.Headers({\"Content-Type\":\"application/json\"}),method:\"POST\",body:JSON.stringify(r)}).then(function(e){return o=e.ok,i=e.status,e.json()}).then(function(e){if(!o)throw e.status=i,_.generateErrorFromResponse(e);return e}).then(O(n))}function C(e,t,n){return new Promise(function(r,o){e._query(t,n,function(e,t){if(e)return o(e);r(t)})})}function R(e){return new Promise(function(t,n){e._viewCleanup(function(e,r){if(e)return n(e);t(r)})})}function T(e){return function(t){if(404===t.status)return e;throw t}}function L(e,t,n){function r(e){return e.keys.length?t.db.allDocs({keys:e.keys,include_docs:!0}):Promise.resolve({rows:[]})}function o(e,t){for(var n=[],r=new h.Set,o=0,i=t.rows.length;o<i;o++){var s=t.rows[o],a=s.doc;if(a&&(n.push(a),r.add(a._id),a._deleted=!u.has(a._id),!a._deleted)){var c=u.get(a._id);\"value\"in c&&(a.value=c.value)}}var f=y.mapToKeysArray(u);return f.forEach(function(e){if(!r.has(e)){var t={_id:e},o=u.get(e);\"value\"in o&&(t.value=o.value),n.push(t)}}),e.keys=y.uniq(f.concat(e.keys)),n.push(e),n}var i=\"_local/doc_\"+e,s={_id:i,keys:[]},a=n.get(e),u=a[0],f=a[1];return function(){return c(f)?Promise.resolve(s):t.db.get(i).catch(T(s))}().then(function(e){return r(e).then(function(t){return o(e,t)})})}function B(e,t,n){return e.db.get(\"_local/lastSeq\").catch(T({_id:\"_local/lastSeq\",seq:0})).then(function(r){var o=y.mapToKeysArray(t);return Promise.all(o.map(function(n){return L(n,e,t)})).then(function(t){var o=l.flatten(t);return r.seq=n,o.push(r),e.db.bulkDocs({docs:o})})})}function P(e){var t=\"string\"==typeof e?e:e.name,n=m[t];return n||(n=m[t]=new r),n}function N(e){return y.sequentialize(P(e),function(){return M(e)})()}function M(e){function n(e,t){var n={id:l._id,key:v.normalizeKey(e)};void 0!==t&&null!==t&&(n.value=v.normalizeKey(t)),f.push(n)}function o(t,n){return function(){return B(e,t,n)}}function s(){return e.sourceDB.changes({return_docs:!0,conflicts:!0,include_docs:!0,style:\"all_docs\",since:_,limit:w}).then(a)}function a(e){var t=e.results;if(t.length){var n=c(t);if(g.add(o(n,_)),!(t.length<w))return s()}}function c(t){for(var n=new h.Map,r=0,o=t.length;r<o;r++){var s=t[r];if(\"_\"!==s.doc._id[0]){f=[],l=s.doc,l._deleted||i(e.sourceDB,p,l),f.sort(d);var a=u(f);n.set(s.doc._id,[a,s.changes])}_=s.seq}return n}function u(e){for(var t,n=new h.Map,r=0,o=e.length;r<o;r++){var i=e[r],s=[i.key,i.id];r>0&&0===v.collate(i.key,t)&&s.push(r),n.set(v.toIndexableString(s),i),t=i.key}return n}var f,l,p=t(e.mapFun,n),_=e.seq||0,g=new r;return s().then(function(){return g.finish()}).then(function(){e.seq=_})}function $(e,t,r){0===r.group_level&&delete r.group_level;var o=r.group||r.group_level,i=n(e.reduceFun),s=[],a=isNaN(r.group_level)?Number.POSITIVE_INFINITY:r.group_level;t.forEach(function(e){var t=s[s.length-1],n=o?e.key:null;if(o&&Array.isArray(n)&&(n=n.slice(0,a)),t&&0===v.collate(t.groupKey,n))return t.keys.push([e.key,e.id]),void t.values.push(e.value);s.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var c=0,u=s.length;c<u;c++){var l=s[c],d=f(e.sourceDB,i,l.keys,l.values,!1);if(d.error&&d.error instanceof y.BuiltInError)throw d.error;t.push({value:d.error?null:d.output,key:l.groupKey})}return{rows:k(t,r.limit,r.skip)}}function F(e,t){return y.sequentialize(P(e),function(){return U(e,t)})()}function U(e,t){function n(t){return t.include_docs=!0,e.db.allDocs(t).then(function(e){return o=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(t<n||t>n))return e.doc.value}var r=v.parseIndexableString(e.doc._id);return{key:r[0],id:r[1],value:\"value\"in e.doc?e.doc.value:null}})})}function r(n){var r;if(r=i?$(e,n,t):{total_rows:o,offset:s,rows:n},t.update_seq&&(r.update_seq=e.seq),t.include_docs){var a=y.uniq(n.map(E));return e.sourceDB.allDocs({keys:a,include_docs:!0,conflicts:t.conflicts,attachments:t.attachments,binary:t.binary}).then(function(e){var t=new h.Map;return e.rows.forEach(function(e){t.set(e.id,e.doc)}),n.forEach(function(e){var n=E(e),r=t.get(n);r&&(e.doc=r)}),r})}return r}var o,i=e.reduceFun&&!1!==t.reduce,s=t.skip||0;if(void 0===t.keys||t.keys.length||(t.limit=0,delete t.keys),void 0!==t.keys){var a=t.keys,c=a.map(function(e){var r={startkey:v.toIndexableString([e]),endkey:v.toIndexableString([e,{}])};return t.update_seq&&(r.update_seq=!0),n(r)});return Promise.all(c).then(l.flatten).then(r)}var u={descending:t.descending};t.update_seq&&(u.update_seq=!0);var f,d;if(\"start_key\"in t&&(f=t.start_key),\"startkey\"in t&&(f=t.startkey),\"end_key\"in t&&(d=t.end_key),\"endkey\"in t&&(d=t.endkey),void 0!==f&&(u.startkey=t.descending?v.toIndexableString([f,{}]):v.toIndexableString([f])),void 0!==d){var p=!1!==t.inclusive_end;t.descending&&(p=!p),u.endkey=v.toIndexableString(p?[d,{}]:[d])}if(void 0!==t.key){var _=v.toIndexableString([t.key]),g=v.toIndexableString([t.key,{}]);u.descending?(u.endkey=_,u.startkey=g):(u.startkey=_,u.endkey=g)}return i||(\"number\"==typeof t.limit&&(u.limit=t.limit),u.skip=s),n(u).then(r)}function K(e){return e.fetch(\"_view_cleanup\",{headers:new g.Headers({\"Content-Type\":\"application/json\"}),method:\"POST\"}).then(function(e){return e.json()})}function J(t){return t.get(\"_local/\"+e).then(function(e){var n=new h.Map;Object.keys(e.views).forEach(function(e){var t=a(e),r=\"_design/\"+t[0],o=t[1],i=n.get(r);i||(i=new h.Set,n.set(r,i)),i.add(o)});var r={keys:y.mapToKeysArray(n),include_docs:!0};return t.allDocs(r).then(function(r){var o={};r.rows.forEach(function(t){var r=t.key.substring(8);n.get(t.key).forEach(function(n){var i=r+\"/\"+n;e.views[i]||(i=n);var s=Object.keys(e.views[i]),a=t.doc&&t.doc.views&&t.doc.views[n];s.forEach(function(e){o[e]=o[e]||a})})});var i=Object.keys(o).filter(function(e){return!o[e]}),s=i.map(function(e){return y.sequentialize(P(e),function(){return new t.constructor(e,t.__opts).destroy()})()});return Promise.all(s).then(function(){return{ok:!0}})})},T({ok:!0}))}function G(t,n,r){if(\"function\"==typeof t._query)return C(t,n,r);if(l.isRemote(t))return x(t,n,r);if(\"string\"!=typeof n)return q(r,n),b.add(function(){return s(t,\"temp_view/temp_view\",n.map,n.reduce,!0,e).then(function(e){return y.fin(N(e).then(function(){return F(e,r)}),function(){return e.db.destroy()})})}),b.finish();var i=n,c=a(i),u=c[0],f=c[1];return t.get(\"_design/\"+u).then(function(n){var a=n.views&&n.views[f];if(!a)throw new y.NotFoundError(\"ddoc \"+n._id+\" has no view named \"+f);return o(n,f),q(r,a),s(t,i,a.map,a.reduce,!1,e).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&l.nextTick(function(){N(e)}),F(e,r)):N(e).then(function(){return F(e,r)})})})}function V(e,t,n){var r=this;\"function\"==typeof t&&(n=t,t={}),t=t?j(t):{},\"function\"==typeof e&&(e={map:e});var o=Promise.resolve().then(function(){return G(r,e,t)});return y.promisedCallback(o,n),o}return{query:V,viewCleanup:y.callbackify(function(){var e=this;return\"function\"==typeof e._viewCleanup?R(e):l.isRemote(e)?K(e):J(e)})}}var l=e(36),d=e(30),h=e(22),p=e(18),v=e(21),_=e(24),g=e(25),y=e(28);r.prototype.add=function(e){return this.promise=this.promise.catch(function(){}).then(function(){return e()}),this.promise},r.prototype.finish=function(){return this.promise};var m={},b=new r,w=50;t.exports=f},{18:18,21:21,22:22,24:24,25:25,28:28,30:30,36:36}],15:[function(e,t,n){(function(n){\"use strict\";function r(e,t){return new Promise(function(n,r){function o(){f++,e[l++]().then(s,a)}function i(){++d===h?u?r(u):n():c()}function s(){f--,i()}function a(e){f--,u=u||e,i()}function c(){for(;f<t&&l<h;)o()}var u,f=0,l=0,d=0,h=e.length;c()})}function o(e){var t=e.doc||e.ok,n=t._attachments;n&&Object.keys(n).forEach(function(e){var t=n[e];t.data=m.base64StringToBlobOrBuffer(t.data,t.content_type)})}function i(e){return/^_design/.test(e)?\"_design/\"+encodeURIComponent(e.slice(8)):/^_local/.test(e)?\"_local/\"+encodeURIComponent(e.slice(7)):encodeURIComponent(e)}function s(e){return e._attachments&&Object.keys(e._attachments)?Promise.all(Object.keys(e._attachments).map(function(t){var n=e._attachments[t];if(n.data&&\"string\"!=typeof n.data)return new Promise(function(e){m.blobOrBufferToBase64(n.data,e)}).then(function(e){n.data=e})})):Promise.resolve()}function a(e){if(!e.prefix)return!1;var t=_.parseUri(e.prefix).protocol;return\"http\"===t||\"https\"===t}function c(e,t){if(a(t)){var n=t.name.substr(t.prefix.length);e=t.prefix.replace(/\\/?$/,\"/\")+encodeURIComponent(n)}var r=_.parseUri(e);(r.user||r.password)&&(r.auth={username:r.user,password:r.password});var o=r.path.replace(/(^\\/|\\/$)/g,\"\").split(\"/\");return r.db=o.pop(),-1===r.db.indexOf(\"%\")&&(r.db=encodeURIComponent(r.db)),r.path=o.join(\"/\"),r}function u(e,t){return f(e,e.db+\"/\"+t)}function f(e,t){var n=e.path?\"/\":\"\";return e.protocol+\"://\"+e.host+(e.port?\":\"+e.port:\"\")+\"/\"+e.path+n+t}function l(e){return\"?\"+Object.keys(e).map(function(t){return t+\"=\"+encodeURIComponent(e[t])}).join(\"&\")}function d(e){var t=\"undefined\"!=typeof navigator&&navigator.userAgent?navigator.userAgent.toLowerCase():\"\",n=-1!==t.indexOf(\"msie\"),r=-1!==t.indexOf(\"trident\"),o=-1!==t.indexOf(\"edge\"),i=!(\"method\"in e)||\"GET\"===e.method;return(n||r||o)&&i}function h(e,t){function a(e,t){return _.adapterFun(e,y(function(e){p().then(function(){return t.apply(this,e)}).catch(function(t){e.pop()(t)})})).bind(A)}function h(e,t,n){var r={};return t=t||{},t.headers=t.headers||new g.Headers,t.headers.get(\"Content-Type\")||t.headers.set(\"Content-Type\",\"application/json\"),t.headers.get(\"Accept\")||t.headers.set(\"Accept\",\"application/json\"),q(e,t).then(function(e){return r.ok=e.ok,r.status=e.status,e.json()}).then(function(e){if(r.data=e,!r.ok){r.data.status=r.status;var t=v.generateErrorFromResponse(r.data);if(n)return n(t);throw t}if(Array.isArray(r.data)&&(r.data=r.data.map(function(e){return e.error||e.missing?v.generateErrorFromResponse(e):e})),!n)return r;n(null,r.data)})}function p(){return e.skip_setup?Promise.resolve():D||(D=h(j).catch(function(e){return e&&e.status&&404===e.status?(_.explainError(404,\"PouchDB is just detecting if the remote exists.\"),h(j,{method:\"PUT\"})):Promise.reject(e)}).catch(function(e){return!(!e||!e.status||412!==e.status)||Promise.reject(e)}),D.catch(function(){D=null}),D)}function O(e){\nreturn e.split(\"/\").map(encodeURIComponent).join(\"/\")}var A=this,I=c(e.name,e),j=u(I,\"\");e=_.clone(e);var D,q=function(t,n){if(n=n||{},n.headers=n.headers||new g.Headers,e.auth||I.auth){var r=e.auth||I.auth,o=r.username+\":\"+r.password,i=m.btoa(unescape(encodeURIComponent(o)));n.headers.set(\"Authorization\",\"Basic \"+i)}var s=e.headers||{};return Object.keys(s).forEach(function(e){n.headers.append(e,s[e])}),d(n)&&(t+=(-1===t.indexOf(\"?\")?\"?\":\"&\")+\"_nonce=\"+Date.now()),(e.fetch||g.fetch)(t,n)};_.nextTick(function(){t(null,A)}),A._remote=!0,A.type=function(){return\"http\"},A.id=a(\"id\",function(e){q(f(I,\"\")).then(function(e){return e.json()}).then(function(t){var n=t&&t.uuid?t.uuid+I.db:u(I,\"\");e(null,n)}).catch(function(t){e(t)})}),A.compact=a(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=_.clone(e),h(u(I,\"_compact\"),{method:\"POST\"}).then(function(){function n(){A.info(function(r,o){o&&!o.compact_running?t(null,{ok:!0}):setTimeout(n,e.interval||200)})}n()})}),A.bulkGet=_.adapterFun(\"bulkGet\",function(e,t){function n(t){var n={};e.revs&&(n.revs=!0),e.attachments&&(n.attachments=!0),e.latest&&(n.latest=!0),h(u(I,\"_bulk_get\"+l(n)),{method:\"POST\",body:JSON.stringify({docs:e.docs})}).then(function(n){e.attachments&&e.binary&&n.data.results.forEach(function(e){e.docs.forEach(o)}),t(null,n.data)}).catch(t)}function r(){for(var n=w,r=Math.ceil(e.docs.length/n),o=0,s=new Array(r),a=0;a<r;a++){var c=_.pick(e,[\"revs\",\"attachments\",\"binary\",\"latest\"]);c.docs=e.docs.slice(a*n,Math.min(e.docs.length,(a+1)*n)),_.bulkGetShim(i,c,function(e){return function(n,i){s[e]=i.results,++o===r&&t(null,{results:_.flatten(s)})}}(a))}}var i=this,s=f(I,\"\"),a=S[s];\"boolean\"!=typeof a?n(function(e,n){e?(S[s]=!1,_.explainError(e.status,\"PouchDB is just detecting if the remote supports the _bulk_get API.\"),r()):(S[s]=!0,t(null,n))}):a?n(t):r()}),A._info=function(e){p().then(function(){return q(u(I,\"\"))}).then(function(e){return e.json()}).then(function(t){t.host=u(I,\"\"),e(null,t)}).catch(e)},A.fetch=function(e,t){return p().then(function(){return q(u(I,e),t)})},A.get=a(\"get\",function(e,t,o){function s(e){function o(r){var o=s[r],a=i(e._id)+\"/\"+O(r)+\"?rev=\"+e._rev;return q(u(I,a)).then(function(e){return void 0===n||n.browser?e.blob():e.buffer()}).then(function(e){return t.binary?(void 0===n||n.browser||(e.type=o.content_type),e):new Promise(function(t){m.blobOrBufferToBase64(e,t)})}).then(function(e){delete o.stub,delete o.length,o.data=e})}var s=e._attachments,a=s&&Object.keys(s);if(s&&a.length){return r(a.map(function(e){return function(){return o(e)}}),5)}}function a(e){return Array.isArray(e)?Promise.all(e.map(function(e){if(e.ok)return s(e.ok)})):s(e)}\"function\"==typeof t&&(o=t,t={}),t=_.clone(t);var c={};t.revs&&(c.revs=!0),t.revs_info&&(c.revs_info=!0),t.latest&&(c.latest=!0),t.open_revs&&(\"all\"!==t.open_revs&&(t.open_revs=JSON.stringify(t.open_revs)),c.open_revs=t.open_revs),t.rev&&(c.rev=t.rev),t.conflicts&&(c.conflicts=t.conflicts),t.update_seq&&(c.update_seq=t.update_seq),e=i(e),h(u(I,e+l(c))).then(function(e){return Promise.resolve().then(function(){if(t.attachments)return a(e.data)}).then(function(){o(null,e.data)})}).catch(function(t){t.docId=e,o(t)})}),A.remove=a(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,\"function\"==typeof t?(r=t,n={}):(r=n,n=t));var s=o._rev||n.rev;h(u(I,i(o._id))+\"?rev=\"+s,{method:\"DELETE\"},r).catch(r)}),A.getAttachment=a(\"getAttachment\",function(e,t,r,o){\"function\"==typeof r&&(o=r,r={});var s,a=r.rev?\"?rev=\"+r.rev:\"\",c=u(I,i(e))+\"/\"+O(t)+a;q(c,{method:\"GET\"}).then(function(e){if(s=e.headers.get(\"content-type\"),e.ok)return void 0===n||n.browser?e.blob():e.buffer();throw e}).then(function(e){void 0===n||n.browser||(e.type=s),o(null,e)}).catch(function(e){o(e)})}),A.removeAttachment=a(\"removeAttachment\",function(e,t,n,r){h(u(I,i(e)+\"/\"+O(t))+\"?rev=\"+n,{method:\"DELETE\"},r).catch(r)}),A.putAttachment=a(\"putAttachment\",function(e,t,n,r,o,s){\"function\"==typeof o&&(s=o,o=r,r=n,n=null);var a=i(e)+\"/\"+O(t),c=u(I,a);if(n&&(c+=\"?rev=\"+n),\"string\"==typeof r){var f;try{f=m.atob(r)}catch(e){return s(v.createError(v.BAD_ARG,\"Attachment is not a valid base64 string\"))}r=f?m.binaryStringToBlobOrBuffer(f,o):\"\"}h(c,{headers:new g.Headers({\"Content-Type\":o}),method:\"PUT\",body:r},s).catch(s)}),A._bulkDocs=function(e,t,n){e.new_edits=t.new_edits,p().then(function(){return Promise.all(e.docs.map(s))}).then(function(){return h(u(I,\"_bulk_docs\"),{method:\"POST\",body:JSON.stringify(e)},n)}).catch(n)},A._put=function(e,t,n){p().then(function(){return s(e)}).then(function(){return h(u(I,i(e._id)),{method:\"PUT\",body:JSON.stringify(e)})}).then(function(e){n(null,e.data)}).catch(function(t){t.docId=e&&e._id,n(t)})},A.allDocs=a(\"allDocs\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=_.clone(e);var n,r={},i=\"GET\";e.conflicts&&(r.conflicts=!0),e.update_seq&&(r.update_seq=!0),e.descending&&(r.descending=!0),e.include_docs&&(r.include_docs=!0),e.attachments&&(r.attachments=!0),e.key&&(r.key=JSON.stringify(e.key)),e.start_key&&(e.startkey=e.start_key),e.startkey&&(r.startkey=JSON.stringify(e.startkey)),e.end_key&&(e.endkey=e.end_key),e.endkey&&(r.endkey=JSON.stringify(e.endkey)),void 0!==e.inclusive_end&&(r.inclusive_end=!!e.inclusive_end),void 0!==e.limit&&(r.limit=e.limit),void 0!==e.skip&&(r.skip=e.skip);var s=l(r);void 0!==e.keys&&(i=\"POST\",n={keys:e.keys}),h(u(I,\"_all_docs\"+s),{method:i,body:JSON.stringify(n)}).then(function(n){e.include_docs&&e.attachments&&e.binary&&n.data.rows.forEach(o),t(null,n.data)}).catch(t)}),A._changes=function(e){var t=\"batch_size\"in e?e.batch_size:b;e=_.clone(e),!e.continuous||\"heartbeat\"in e||(e.heartbeat=E);var n=\"timeout\"in e?e.timeout:3e4;\"timeout\"in e&&e.timeout&&n-e.timeout<k&&(n=e.timeout+k),\"heartbeat\"in e&&e.heartbeat&&n-e.heartbeat<k&&(n=e.heartbeat+k);var r={};\"timeout\"in e&&e.timeout&&(r.timeout=e.timeout);var i=void 0!==e.limit&&e.limit,s=i;if(e.style&&(r.style=e.style),(e.include_docs||e.filter&&\"function\"==typeof e.filter)&&(r.include_docs=!0),e.attachments&&(r.attachments=!0),e.continuous&&(r.feed=\"longpoll\"),e.seq_interval&&(r.seq_interval=e.seq_interval),e.conflicts&&(r.conflicts=!0),e.descending&&(r.descending=!0),e.update_seq&&(r.update_seq=!0),\"heartbeat\"in e&&e.heartbeat&&(r.heartbeat=e.heartbeat),e.filter&&\"string\"==typeof e.filter&&(r.filter=e.filter),e.view&&\"string\"==typeof e.view&&(r.filter=\"_view\",r.view=e.view),e.query_params&&\"object\"==typeof e.query_params)for(var a in e.query_params)e.query_params.hasOwnProperty(a)&&(r[a]=e.query_params[a]);var c,f=\"GET\";e.doc_ids?(r.filter=\"_doc_ids\",f=\"POST\",c={doc_ids:e.doc_ids}):e.selector&&(r.filter=\"_selector\",f=\"POST\",c={selector:e.selector});var d,v=new g.AbortController,y=function(n,o){if(!e.aborted){r.since=n,\"object\"==typeof r.since&&(r.since=JSON.stringify(r.since)),e.descending?i&&(r.limit=s):r.limit=!i||s>t?t:s;var a=u(I,\"_changes\"+l(r)),_={signal:v.signal,method:f,body:JSON.stringify(c)};d=n,e.aborted||p().then(function(){return h(a,_,o)}).catch(o)}},m={results:[]},w=function(n,r){if(!e.aborted){var a=0;if(r&&r.results){a=r.results.length,m.last_seq=r.last_seq;var c=null,u=null;\"number\"==typeof r.pending&&(c=r.pending),\"string\"!=typeof m.last_seq&&\"number\"!=typeof m.last_seq||(u=m.last_seq);({}).query=e.query_params,r.results=r.results.filter(function(t){s--;var n=_.filterChange(e)(t);return n&&(e.include_docs&&e.attachments&&e.binary&&o(t),e.return_docs&&m.results.push(t),e.onChange(t,c,u)),n})}else if(n)return e.aborted=!0,void e.complete(n);r&&r.last_seq&&(d=r.last_seq);var f=i&&s<=0||r&&a<t||e.descending;(!e.continuous||i&&s<=0)&&f?e.complete(null,m):_.nextTick(function(){y(d,w)})}};return y(e.since||0,w),{cancel:function(){e.aborted=!0,v.abort()}}},A.revsDiff=a(\"revsDiff\",function(e,t,n){\"function\"==typeof t&&(n=t,t={}),h(u(I,\"_revs_diff\"),{method:\"POST\",body:JSON.stringify(e)},n).catch(n)}),A._close=function(e){e()},A._destroy=function(e,t){h(u(I,\"\"),{method:\"DELETE\"}).then(function(e){t(null,e)}).catch(function(e){404===e.status?t(null,{ok:!0}):t(e)})}}function p(e){e.adapter(\"http\",h,!1),e.adapter(\"https\",h,!1)}var v=e(24),_=e(36),g=e(25),y=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(7)),m=e(18),b=25,w=50,k=5e3,E=1e4,S={};h.valid=function(){return!0},t.exports=p}).call(this,e(37))},{18:18,24:24,25:25,36:36,37:37,7:7}],16:[function(e,t,n){\"use strict\";function r(e){return function(t){var n=\"unknown_error\";t.target&&t.target.error&&(n=t.target.error.name||t.target.error.message),e(D.createError(D.IDB_ERROR,n,t.type))}}function o(e,t,n){return{data:q.safeJsonStringify(e),winningRev:t,deletedOrLocal:n?\"1\":\"0\",seq:e.seq,id:e.id}}function i(e){if(!e)return null;var t=q.safeJsonParse(e.data);return t.winningRev=e.winningRev,t.deleted=\"1\"===e.deletedOrLocal,t.seq=e.seq,t}function s(e){if(!e)return e;var t=e._doc_id_rev.lastIndexOf(\":\");return e._id=e._doc_id_rev.substring(0,t-1),e._rev=e._doc_id_rev.substring(t+1),delete e._doc_id_rev,e}function a(e,t,n,r){n?r(e?\"string\"!=typeof e?e:x.base64StringToBlobOrBuffer(e,t):x.blob([\"\"],{type:t})):e?\"string\"!=typeof e?x.readAsBinaryString(e,function(e){r(x.btoa(e))}):r(e):r(\"\")}function c(e,t,n,r){function o(){++a===s.length&&r&&r()}function i(e,t){var r=e._attachments[t],i=r.digest;n.objectStore(N).get(i).onsuccess=function(e){r.body=e.target.result.body,o()}}var s=Object.keys(e._attachments||{});if(!s.length)return r&&r();var a=0;s.forEach(function(n){t.attachments&&t.include_docs?i(e,n):(e._attachments[n].stub=!0,o())})}function u(e,t){return Promise.all(e.map(function(e){if(e.doc&&e.doc._attachments){var n=Object.keys(e.doc._attachments);return Promise.all(n.map(function(n){var r=e.doc._attachments[n];if(\"body\"in r){var o=r.body,i=r.content_type;return new Promise(function(s){a(o,i,t,function(t){e.doc._attachments[n]=j.assign(j.pick(r,[\"digest\",\"content_type\"]),{data:t}),s()})})}}))}}))}function f(e,t,n){function r(){--u||o()}function o(){i.length&&i.forEach(function(e){c.index(\"digestSeq\").count(IDBKeyRange.bound(e+\"::\",e+\"::￿\",!1,!1)).onsuccess=function(t){t.target.result||a.delete(e)}})}var i=[],s=n.objectStore(P),a=n.objectStore(N),c=n.objectStore(M),u=e.length;e.forEach(function(e){var n=s.index(\"_doc_id_rev\"),o=t+\"::\"+e;n.getKey(o).onsuccess=function(e){var t=e.target.result;if(\"number\"!=typeof t)return r();s.delete(t),c.index(\"seq\").openCursor(IDBKeyRange.only(t)).onsuccess=function(e){var t=e.target.result;if(t){var n=t.value.digestSeq.split(\"::\")[0];i.push(n),c.delete(t.primaryKey),t.continue()}else r()}}})}function l(e,t,n){try{return{txn:e.transaction(t,n)}}catch(e){return{error:e}}}function d(e,t,n,s,a,c){function u(){var e=[B,P,N,F,M,$],t=l(a,e,\"readwrite\");if(t.error)return c(t.error);S=t.txn,S.onabort=r(c),S.ontimeout=r(c),S.oncomplete=_,O=S.objectStore(B),A=S.objectStore(P),I=S.objectStore(N),j=S.objectStore(M),q=S.objectStore($),q.get($).onsuccess=function(e){L=e.target.result,p()},y(function(e){if(e)return Y=!0,c(e);v()})}function d(){z=!0,p()}function h(){R.processDocs(e.revs_limit,U,s,H,S,W,m,n,d)}function p(){L&&z&&(L.docCount+=Q,q.put(L))}function v(){function e(){++n===U.length&&h()}function t(t){var n=i(t.target.result);n&&H.set(n.id,n),e()}if(U.length)for(var n=0,r=0,o=U.length;r<o;r++){var s=U[r];if(s._id&&R.isLocalId(s._id))e();else{var a=O.get(s.metadata.id);a.onsuccess=t}}}function _(){Y||(K.notify(s._meta.name),c(null,W))}function g(e,t){I.get(e).onsuccess=function(n){if(n.target.result)t();else{var r=D.createError(D.MISSING_STUB,\"unknown stub attachment with digest \"+e);r.status=412,t(r)}}}function y(e){function t(){++o===n.length&&e(r)}var n=[];if(U.forEach(function(e){e.data&&e.data._attachments&&Object.keys(e.data._attachments).forEach(function(t){var r=e.data._attachments[t];r.stub&&n.push(r.digest)})}),!n.length)return e();var r,o=0;n.forEach(function(e){g(e,function(e){e&&!r&&(r=e),t()})})}function m(e,t,n,r,o,i,s,a){e.metadata.winningRev=t,e.metadata.deleted=n;var c=e.data;if(c._id=e.metadata.id,c._rev=e.metadata.rev,r&&(c._deleted=!0),c._attachments&&Object.keys(c._attachments).length)return w(e,t,n,o,s,a);Q+=i,p(),b(e,t,n,o,s,a)}function b(e,t,n,r,i,a){function c(i){var a=e.stemmedRevs||[];r&&s.auto_compaction&&(a=a.concat(T.compactTree(e.metadata))),a&&a.length&&f(a,e.metadata.id,S),h.seq=i.target.result;var c=o(h,t,n);O.put(c).onsuccess=l}function u(e){e.preventDefault(),e.stopPropagation(),A.index(\"_doc_id_rev\").getKey(d._doc_id_rev).onsuccess=function(e){A.put(d,e.target.result).onsuccess=c}}function l(){W[i]={ok:!0,id:h.id,rev:h.rev},H.set(e.metadata.id,e.metadata),k(e,h.seq,a)}var d=e.data,h=e.metadata;d._doc_id_rev=h.id+\"::\"+h.rev,delete d._id,delete d._rev;var p=A.put(d);p.onsuccess=c,p.onerror=u}function w(e,t,n,r,o,i){function s(){u===f.length&&b(e,t,n,r,o,i)}function a(){u++,s()}var c=e.data,u=0,f=Object.keys(c._attachments);f.forEach(function(n){var r=e.data._attachments[n];if(r.stub)u++,s();else{var o=r.data;delete r.data,r.revpos=parseInt(t,10);E(r.digest,o,a)}})}function k(e,t,n){function r(){++o===i.length&&n()}var o=0,i=Object.keys(e.data._attachments||{});if(!i.length)return n();for(var s=0;s<i.length;s++)!function(n){var o=e.data._attachments[n].digest,i=j.put({seq:t,digestSeq:o+\"::\"+t});i.onsuccess=r,i.onerror=function(e){e.preventDefault(),e.stopPropagation(),r()}}(i[s])}function E(e,t,n){I.count(e).onsuccess=function(r){if(r.target.result)return n();var o={digest:e,body:t};I.put(o).onsuccess=n}}for(var S,O,A,I,j,q,x,L,U=t.docs,J=0,G=U.length;J<G;J++){var V=U[J];V._id&&R.isLocalId(V._id)||(V=U[J]=R.parseDoc(V,n.new_edits,e),V.error&&!x&&(x=V))}if(x)return c(x);var z=!1,Q=0,W=new Array(U.length),H=new C.Map,Y=!1,Z=s._meta.blobSupport?\"blob\":\"base64\";R.preprocessAttachments(U,Z,function(e){if(e)return c(e);u()})}function h(e,t,n,r,o){function i(e){f=e.target.result,u&&o(u,f,l)}function s(e){u=e.target.result,f&&o(u,f,l)}function a(){if(!u.length)return o();var n,a=u[u.length-1];if(t&&t.upper)try{n=IDBKeyRange.bound(a,t.upper,!0,t.upperOpen)}catch(e){if(\"DataError\"===e.name&&0===e.code)return o()}else n=IDBKeyRange.lowerBound(a,!0);t=n,u=null,f=null,e.getAll(t,r).onsuccess=i,e.getAllKeys(t,r).onsuccess=s}function c(e){var t=e.target.result;if(!t)return o();o([t.key],[t.value],t)}-1===r&&(r=1e3);var u,f,l,d=\"function\"==typeof e.getAll&&\"function\"==typeof e.getAllKeys&&r>1&&!n;d?(l={continue:a},e.getAll(t,r).onsuccess=i,e.getAllKeys(t,r).onsuccess=s):n?e.openCursor(t,\"prev\").onsuccess=c:e.openCursor(t).onsuccess=c}function p(e,t,n){function r(e){var t=e.target.result;t?(o.push(t.value),t.continue()):n({target:{result:o}})}if(\"function\"==typeof e.getAll)return void(e.getAll(t).onsuccess=n);var o=[];e.openCursor(t).onsuccess=r}function v(e,t,n){var r=new Array(e.length),o=0;e.forEach(function(i,s){t.get(i).onsuccess=function(t){t.target.result?r[s]=t.target.result:r[s]={key:i,error:\"not_found\"},++o===e.length&&n(e,r,{})}})}function _(e,t,n,r,o){try{if(e&&t)return o?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return o?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return o?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(e){return{error:e}}return null}function g(e,t,n){function o(t,n,r){var o=t.id+\"::\"+r;K.get(o).onsuccess=function(r){if(n.doc=s(r.target.result)||{},e.conflicts){var o=T.collectConflicts(t);o.length&&(n.doc._conflicts=o)}c(n.doc,e,C)}}function a(t,n){var r={id:n.id,key:n.id,value:{rev:t}};n.deleted?O&&(J.push(r),r.value.deleted=!0,r.doc=null):A--<=0&&(J.push(r),e.include_docs&&o(n,r,t))}function f(e){for(var t=0,n=e.length;t<n&&J.length!==I;t++){var r=e[t];if(r.error&&O)J.push(r);else{var o=i(r);a(o.winningRev,o)}}}function d(e,t,n){n&&(f(t),J.length<I&&n.continue())}function g(t){var n=t.target.result;e.descending&&(n=n.reverse()),f(n)}function y(){var t={total_rows:R,offset:e.skip,rows:J};e.update_seq&&void 0!==L&&(t.update_seq=L),n(null,t)}function m(){e.attachments?u(J,e.binary).then(y):y()}var b,w,k=\"startkey\"in e&&e.startkey,E=\"endkey\"in e&&e.endkey,S=\"key\"in e&&e.key,O=\"keys\"in e&&e.keys,A=e.skip||0,I=\"number\"==typeof e.limit?e.limit:-1,j=!1!==e.inclusive_end;if(!O&&(b=_(k,E,j,S,e.descending),(w=b&&b.error)&&(\"DataError\"!==w.name||0!==w.code)))return n(D.createError(D.IDB_ERROR,w.name,w.message));var q=[B,P,$];e.attachments&&q.push(N);var x=l(t,q,\"readonly\");if(x.error)return n(x.error);var C=x.txn;C.oncomplete=m,C.onabort=r(n);var R,L,M=C.objectStore(B),F=C.objectStore(P),U=C.objectStore($),K=F.index(\"_doc_id_rev\"),J=[];return U.get($).onsuccess=function(e){R=e.target.result.docCount},e.update_seq&&function(e,t){function n(e){var n=e.target.result,r=void 0;return n&&n.key&&(r=n.key),t({target:{result:[r]}})}e.openCursor(null,\"prev\").onsuccess=n}(F,function(e){e.target.result&&e.target.result.length>0&&(L=e.target.result[0])}),w||0===I?void 0:O?v(e.keys,M,d):-1===I?p(M,b,g):void h(M,b,e.descending,I+A,d)}function y(e){return new Promise(function(t){var n=x.blob([\"\"]),r=e.objectStore(U).put(n,\"key\");r.onsuccess=function(){var e=navigator.userAgent.match(/Chrome\\/(\\d+)/),n=navigator.userAgent.match(/Edge\\//);t(n||!e||parseInt(e[1],10)>=43)},r.onerror=e.onabort=function(e){e.preventDefault(),e.stopPropagation(),t(!1)}}).catch(function(){return!1})}function m(e,t){e.objectStore(B).index(\"deletedOrLocal\").count(IDBKeyRange.only(\"0\")).onsuccess=function(e){t(e.target.result)}}function b(e,t,n,r){try{e(t,n)}catch(t){r.emit(\"error\",t)}}function w(){!J&&G.length&&(J=!0,G.shift()())}function k(e,t,n){G.push(function(){e(function(e,r){b(t,e,r,n),J=!1,j.nextTick(function(){w(n)})})}),w()}function E(e,t,n,o){function a(t,n,r){function o(t,n){var r=e.processChange(n,t,e);y=r.seq=t.seq;var o=A(r);return\"object\"==typeof o?Promise.reject(o):o?(O++,e.return_docs&&S.push(r),e.attachments&&e.include_docs?new Promise(function(t){c(n,e,b,function(){u([r],e.binary).then(function(){t(r)})})}):Promise.resolve(r)):Promise.resolve()}function i(){for(var t=[],n=0,i=a.length;n<i&&O!==m;n++){var s=a[n];if(s){var c=f[n];t.push(o(c,s))}}Promise.all(t).then(function(t){for(var n=0,r=t.length;n<r;n++)t[n]&&e.onChange(t[n])}).catch(e.complete),O!==m&&r.continue()}if(r&&t.length){var a=new Array(t.length),f=new Array(t.length),l=0;n.forEach(function(e,n){d(s(e),t[n],function(e,r){f[n]=e,a[n]=r,++l===t.length&&i()})})}}function f(e,t,n,r){if(n.seq!==t)return r();if(n.winningRev===e._rev)return r(n,e);var o=e._id+\"::\"+n.winningRev;E.get(o).onsuccess=function(e){r(n,s(e.target.result))}}function d(e,t,n){if(g&&!g.has(e._id))return n();var r=I.get(e._id);if(r)return f(e,t,r,n);k.get(e._id).onsuccess=function(o){r=i(o.target.result),I.set(e._id,r),f(e,t,r,n)}}function p(){e.complete(null,{results:S,last_seq:y})}function v(){!e.continuous&&e.attachments?u(S).then(p):p()}if(e=j.clone(e),e.continuous){var _=n+\":\"+j.uuid();return K.addListener(n,_,t,e),K.notify(n),{cancel:function(){K.removeListener(n,_)}}}var g=e.doc_ids&&new C.Set(e.doc_ids);e.since=e.since||0;var y=e.since,m=\"limit\"in e?e.limit:-1;0===m&&(m=1);var b,w,k,E,S=[],O=0,A=j.filterChange(e),I=new C.Map,D=[B,P];e.attachments&&D.push(N);var q=l(o,D,\"readonly\");if(q.error)return e.complete(q.error);b=q.txn,b.onabort=r(e.complete),b.oncomplete=v,w=b.objectStore(P),k=b.objectStore(B),E=w.index(\"_doc_id_rev\"),h(w,e.since&&!e.descending?IDBKeyRange.lowerBound(e.since,!0):null,e.descending,m,a)}function S(e,t){var n=this;k(function(t){O(n,e,t)},t,n.constructor)}function O(e,t,n){function c(e){var t=e.createObjectStore(B,{keyPath:\"id\"});e.createObjectStore(P,{autoIncrement:!0}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0}),e.createObjectStore(N,{keyPath:\"digest\"}),e.createObjectStore($,{keyPath:\"id\",autoIncrement:!1}),e.createObjectStore(U),t.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),e.createObjectStore(F,{keyPath:\"_id\"});var n=e.createObjectStore(M,{autoIncrement:!0});n.createIndex(\"seq\",\"seq\"),n.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function u(e,t){var n=e.objectStore(B);n.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),n.openCursor().onsuccess=function(e){var r=e.target.result;if(r){var o=r.value,i=T.isDeleted(o);o.deletedOrLocal=i?\"1\":\"0\",n.put(o),r.continue()}else t()}}function h(e){e.createObjectStore(F,{keyPath:\"_id\"}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0})}function p(e,t){var n=e.objectStore(F),r=e.objectStore(B),o=e.objectStore(P);r.openCursor().onsuccess=function(e){var i=e.target.result;if(i){var s=i.value,a=s.id,c=T.isLocalId(a),u=T.winningRev(s);if(c){var f=a+\"::\"+u,l=a+\"::\",d=a+\"::~\",h=o.index(\"_doc_id_rev\"),p=IDBKeyRange.bound(l,d,!1,!1),v=h.openCursor(p);v.onsuccess=function(e){if(v=e.target.result){var t=v.value;t._doc_id_rev===f&&n.put(t),o.delete(v.primaryKey),v.continue()}else r.delete(i.primaryKey),i.continue()}}else i.continue()}else t&&t()}}function v(e){var t=e.createObjectStore(M,{autoIncrement:!0});t.createIndex(\"seq\",\"seq\"),t.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function _(e,t){var n=e.objectStore(P),r=e.objectStore(N),o=e.objectStore(M);r.count().onsuccess=function(e){if(!e.target.result)return t();n.openCursor().onsuccess=function(e){var n=e.target.result;if(!n)return t();for(var r=n.value,i=n.primaryKey,s=Object.keys(r._attachments||{}),a={},c=0;c<s.length;c++)a[r._attachments[s[c]].digest]=!0;var u=Object.keys(a);for(c=0;c<u.length;c++){var f=u[c];o.put({seq:i,digestSeq:f+\"::\"+i})}n.continue()}}}function b(e){function t(e){return e.data?i(e):(e.deleted=\"1\"===e.deletedOrLocal,e)}var n=e.objectStore(P),r=e.objectStore(B);r.openCursor().onsuccess=function(e){function i(){var e=o(a,a.winningRev,a.deleted);r.put(e).onsuccess=function(){s.continue()}}var s=e.target.result;if(s){var a=t(s.value);if(a.winningRev=a.winningRev||T.winningRev(a),a.seq)return i();!function(){var e=a.id+\"::\",t=a.id+\"::￿\",r=n.index(\"_doc_id_rev\").openCursor(IDBKeyRange.bound(e,t)),o=0;r.onsuccess=function(e){var t=e.target.result;if(!t)return a.seq=o,i();var n=t.primaryKey;n>o&&(o=n),t.continue()}}()}}}var w=t.name,k=null;e._meta=null,e._remote=!1,e.type=function(){return\"idb\"},e._id=j.toPromise(function(t){t(null,e._meta.instanceId)}),e._bulkDocs=function(n,r,o){d(t,n,r,e,k,o)},e._get=function(e,t,n){function r(){n(c,{doc:o,metadata:a,ctx:u})}var o,a,c,u=t.ctx;if(!u){var f=l(k,[B,P,N],\"readonly\");if(f.error)return n(f.error);u=f.txn}u.objectStore(B).get(e).onsuccess=function(e){if(!(a=i(e.target.result)))return c=D.createError(D.MISSING_DOC,\"missing\"),r();var n;if(t.rev)n=t.latest?T.latest(t.rev,a):t.rev;else{n=a.winningRev;if(T.isDeleted(a))return c=D.createError(D.MISSING_DOC,\"deleted\"),r()}var f=u.objectStore(P),l=a.id+\"::\"+n;f.index(\"_doc_id_rev\").get(l).onsuccess=function(e){if(o=e.target.result,o&&(o=s(o)),!o)return c=D.createError(D.MISSING_DOC,\"missing\"),r();r()}}},e._getAttachment=function(e,t,n,r,o){var i;if(r.ctx)i=r.ctx;else{var s=l(k,[B,P,N],\"readonly\");if(s.error)return o(s.error);i=s.txn}var c=n.digest,u=n.content_type;i.objectStore(N).get(c).onsuccess=function(e){a(e.target.result.body,u,r.binary,function(e){o(null,e)})}},e._info=function(t){var n,r,o=l(k,[$,P],\"readonly\");if(o.error)return t(o.error);var i=o.txn;i.objectStore($).get($).onsuccess=function(e){r=e.target.result.docCount},i.objectStore(P).openCursor(null,\"prev\").onsuccess=function(e){var t=e.target.result;n=t?t.key:0},i.oncomplete=function(){t(null,{doc_count:r,update_seq:n,idb_attachment_format:e._meta.blobSupport?\"binary\":\"base64\"})}},e._allDocs=function(e,t){g(e,k,t)},e._changes=function(t){return E(t,e,w,k)},e._close=function(e){k.close(),V.delete(w),e()},e._getRevisionTree=function(e,t){var n=l(k,[B],\"readonly\");if(n.error)return t(n.error);n.txn.objectStore(B).get(e).onsuccess=function(e){var n=i(e.target.result);n?t(null,n.rev_tree):t(D.createError(D.MISSING_DOC))}},e._doCompaction=function(e,t,n){var s=[B,P,N,M],a=l(k,s,\"readwrite\");if(a.error)return n(a.error);var c=a.txn;c.objectStore(B).get(e).onsuccess=function(n){var r=i(n.target.result);T.traverseRevTree(r.rev_tree,function(e,n,r,o,i){var s=n+\"-\"+r;-1!==t.indexOf(s)&&(i.status=\"missing\")}),f(t,e,c);var s=r.winningRev,a=r.deleted;c.objectStore(B).put(o(r,s,a))},c.onabort=r(n),c.oncomplete=function(){n()}},e._getLocal=function(e,t){var n=l(k,[F],\"readonly\");if(n.error)return t(n.error);var o=n.txn,i=o.objectStore(F).get(e);i.onerror=r(t),i.onsuccess=function(e){var n=e.target.result;n?(delete n._doc_id_rev,t(null,n)):t(D.createError(D.MISSING_DOC))}},e._putLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),delete e._revisions;var o=e._rev,i=e._id;e._rev=o?\"0-\"+(parseInt(o.split(\"-\")[1],10)+1):\"0-1\";var s,a=t.ctx;if(!a){var c=l(k,[F],\"readwrite\");if(c.error)return n(c.error);a=c.txn,a.onerror=r(n),a.oncomplete=function(){s&&n(null,s)}}var u,f=a.objectStore(F);o?(u=f.get(i),u.onsuccess=function(r){var i=r.target.result;if(i&&i._rev===o){f.put(e).onsuccess=function(){s={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,s)}}else n(D.createError(D.REV_CONFLICT))}):(u=f.add(e),u.onerror=function(e){n(D.createError(D.REV_CONFLICT)),e.preventDefault(),e.stopPropagation()},u.onsuccess=function(){s={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,s)})},e._removeLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={});var o=t.ctx;if(!o){var i=l(k,[F],\"readwrite\");if(i.error)return n(i.error);o=i.txn,o.oncomplete=function(){s&&n(null,s)}}var s,a=e._id,c=o.objectStore(F),u=c.get(a);u.onerror=r(n),u.onsuccess=function(r){var o=r.target.result;o&&o._rev===e._rev?(c.delete(a),s={ok:!0,id:a,rev:\"0-0\"},t.ctx&&n(null,s)):n(D.createError(D.MISSING_DOC))}},e._destroy=function(e,t){K.removeAllListeners(w);var n=z.get(w);n&&n.result&&(n.result.close(),V.delete(w));var o=indexedDB.deleteDatabase(w);o.onsuccess=function(){z.delete(w),j.hasLocalStorage()&&w in localStorage&&delete localStorage[w],t(null,{ok:!0})},o.onerror=r(t)};var S=V.get(w);if(S)return k=S.idb,e._meta=S.global,j.nextTick(function(){n(null,e)});var O=indexedDB.open(w,L);z.set(w,O),O.onupgradeneeded=function(e){function t(){var e=o[i-1];i++,e&&e(r,t)}var n=e.target.result;if(e.oldVersion<1)return c(n);var r=e.currentTarget.transaction;e.oldVersion<3&&h(n),e.oldVersion<4&&v(n);var o=[u,p,_,b],i=e.oldVersion;t()},O.onsuccess=function(t){function o(){void 0!==c&&l&&(e._meta={name:w,instanceId:u,blobSupport:c},V.set(w,{idb:k,global:e._meta}),n(null,e))}function i(){if(void 0!==a&&void 0!==s){var e=w+\"_id\";e in s?u=s[e]:s[e]=u=j.uuid(),s.docCount=a,f.objectStore($).put(s)}}k=t.target.result,k.onversionchange=function(){k.close(),V.delete(w)},k.onabort=function(e){j.guardedConsole(\"error\",\"Database has a global failure\",e.target.error),k.close(),V.delete(w)};var s,a,c,u,f=k.transaction([$,U,B],\"readwrite\"),l=!1;f.objectStore($).get($).onsuccess=function(e){s=e.target.result||{id:$},i()},m(f,function(e){a=e,i()}),I||(I=y(f)),I.then(function(e){c=e,o()}),f.oncomplete=function(){l=!0,o()},f.onabort=r(n)},O.onerror=function(){var e=\"Failed to open indexedDB, are you in private browsing mode?\";j.guardedConsole(\"error\",e),n(D.createError(D.IDB_ERROR,e))}}function A(e){e.adapter(\"idb\",S,!0)}var I,j=e(36),D=e(24),q=e(27),x=e(18),C=e(22),R=e(17),T=e(31),L=5,B=\"document-store\",P=\"by-sequence\",N=\"attach-store\",M=\"attach-seq-store\",$=\"meta-store\",F=\"local-store\",U=\"detect-blob-support\",K=new j.changesHandler,J=!1,G=[],V=new C.Map,z=new C.Map;S.valid=function(){try{return\"undefined\"!=typeof indexedDB&&\"undefined\"!=typeof IDBKeyRange}catch(e){return!1}},t.exports=A},{17:17,18:18,22:22,24:24,27:27,31:31,36:36}],17:[function(e,t,n){\"use strict\";function r(e,t){var n=t.keys,r={offset:t.skip};return Promise.all(n.map(function(n){var o=_.assign({key:n,deleted:\"ok\"},t);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete o[e]}),new Promise(function(i,s){e._allDocs(o,function(e,o){if(e)return s(e);t.update_seq&&void 0!==o.update_seq&&(r.update_seq=o.update_seq),r.total_rows=o.total_rows,i(o.rows[0]||{key:n,error:\"not_found\"})})})})).then(function(e){return r.rows=e,r})}function o(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}function i(e){if(!/^\\d+-./.test(e))return g.createError(g.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),r=e.substring(t+1);return{prefix:parseInt(n,10),id:r}}function s(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,o=[r[0],t,[]],i=1,s=r.length;i<s;i++)o=[r[i],{status:\"missing\"},[o]];return[{pos:n,ids:o}]}function a(e,t,n){n||(n={deterministic_revs:!0});var r,o,a,c={status:\"available\"};if(e._deleted&&(c.deleted=!0),t)if(e._id||(e._id=_.uuid()),o=_.rev(e,n.deterministic_revs),e._rev){if(a=i(e._rev),a.error)return a;e._rev_tree=[{pos:a.prefix,ids:[a.id,{status:\"missing\"},[[o,c,[]]]]}],r=a.prefix+1}else e._rev_tree=[{pos:1,ids:[o,c,[]]}],r=1;else if(e._revisions&&(e._rev_tree=s(e._revisions,c),r=e._revisions.start,o=e._revisions.ids[0]),!e._rev_tree){if(a=i(e._rev),a.error)return a;r=a.prefix,o=a.id,e._rev_tree=[{pos:r,ids:[o,c,[]]}]}_.invalidIdError(e._id),e._rev=r+\"-\"+o;var u={metadata:{},data:{}};for(var f in e)if(Object.prototype.hasOwnProperty.call(e,f)){var l=\"_\"===f[0];if(l&&!k[f]){var d=g.createError(g.DOC_VALIDATION,f);throw d.message=g.DOC_VALIDATION.message+\": \"+f,d}l&&!E[f]?u.metadata[f.slice(1)]=e[f]:u.data[f]=e[f]}return u}function c(e){try{return y.atob(e)}catch(e){var t=g.createError(g.BAD_ARG,\"Attachment is not a valid base64 string\");return{error:t}}}function u(e,t,n){var r=c(e.data);if(r.error)return n(r.error);e.length=r.length,e.data=\"blob\"===t?y.binaryStringToBlobOrBuffer(r,e.content_type):\"base64\"===t?y.btoa(r):r,m.binaryMd5(r,function(t){e.digest=\"md5-\"+t,n()})}function f(e,t,n){m.binaryMd5(e.data,function(r){e.digest=\"md5-\"+r,e.length=e.data.size||e.data.length||0,\"binary\"===t?y.blobOrBufferToBinaryString(e.data,function(t){e.data=t,n()}):\"base64\"===t?y.blobOrBufferToBase64(e.data,function(t){e.data=t,n()}):n()})}function l(e,t,n){if(e.stub)return n();\"string\"==typeof e.data?u(e,t,n):f(e,t,n)}function d(e,t,n){function r(){i++,e.length===i&&(o?n(o):n())}if(!e.length)return n();var o,i=0;e.forEach(function(e){function n(e){o=e,++s===i.length&&r()}var i=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],s=0;if(!i.length)return r();for(var a in e.data._attachments)e.data._attachments.hasOwnProperty(a)&&l(e.data._attachments[a],t,n)})}function h(e,t,n,r,o,i,s,c){if(b.revExists(t.rev_tree,n.metadata.rev)&&!c)return r[o]=n,i();var u=t.winningRev||b.winningRev(t),f=\"deleted\"in t?t.deleted:b.isDeleted(t,u),l=\"deleted\"in n.metadata?n.metadata.deleted:b.isDeleted(n.metadata),d=/^1-/.test(n.metadata.rev);if(f&&!l&&c&&d){var h=n.data;h._rev=u,h._id=n.metadata.id,n=a(h,c)}var p=b.merge(t.rev_tree,n.metadata.rev_tree[0],e);if(c&&(f&&l&&\"new_leaf\"!==p.conflicts||!f&&\"new_leaf\"!==p.conflicts||f&&!l&&\"new_branch\"===p.conflicts)){var v=g.createError(g.REV_CONFLICT);return r[o]=v,i()}var _=n.metadata.rev;n.metadata.rev_tree=p.tree,n.stemmedRevs=p.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map);var y,m=b.winningRev(n.metadata),w=b.isDeleted(n.metadata,m),k=f===w?0:f<w?-1:1;y=_===m?w:b.isDeleted(n.metadata,_),s(n,m,w,y,!0,k,o,i)}function p(e){return\"missing\"===e.metadata.rev_tree[0].ids[1].status}function v(e,t,n,r,o,i,s,a,c){function u(e,t,n){var r=b.winningRev(e.metadata),o=b.isDeleted(e.metadata,r);if(\"was_delete\"in a&&o)return i[t]=g.createError(g.MISSING_DOC,\"deleted\"),n();if(l&&p(e)){var c=g.createError(g.REV_CONFLICT);return i[t]=c,n()}s(e,r,o,o,!1,o?0:1,t,n)}function f(){++v===_&&c&&c()}e=e||1e3;var l=a.new_edits,d=new w.Map,v=0,_=t.length;t.forEach(function(e,t){if(e._id&&b.isLocalId(e._id)){var r=e._deleted?\"_removeLocal\":\"_putLocal\";return void n[r](e,{ctx:o},function(e,n){i[t]=e||n,f()})}var s=e.metadata.id;d.has(s)?(_--,d.get(s).push([e,t])):d.set(s,[[e,t]])}),d.forEach(function(t,n){function o(){++c<t.length?a():f()}function a(){var a=t[c],f=a[0],d=a[1];if(r.has(n))h(e,r.get(n),f,i,d,o,s,l);else{var p=b.merge([],f.metadata.rev_tree[0],e);f.metadata.rev_tree=p.tree,f.stemmedRevs=p.stemmedRevs||[],u(f,d,o)}}var c=0;a()})}Object.defineProperty(n,\"__esModule\",{value:!0})\n;var _=e(36),g=e(24),y=e(18),m=e(30),b=e(31),w=e(22),k=o([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),E=o([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"]);n.invalidIdError=_.invalidIdError,n.normalizeDdocFunctionName=_.normalizeDdocFunctionName,n.parseDdocFunctionName=_.parseDdocFunctionName,n.isDeleted=b.isDeleted,n.isLocalId=b.isLocalId,n.allDocsKeysQuery=r,n.parseDoc=a,n.preprocessAttachments=d,n.processDocs=v,n.updateDoc=h},{18:18,22:22,24:24,30:30,31:31,36:36}],18:[function(e,t,n){\"use strict\";function r(e,t){e=e||[],t=t||{};try{return new Blob(e,t)}catch(i){if(\"TypeError\"!==i.name)throw i;for(var n=\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder,r=new n,o=0;o<e.length;o+=1)r.append(e[o]);return r.getBlob(t.type)}}function o(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function i(e,t){return r([o(e)],{type:t})}function s(e,t){return i(h(e),t)}function a(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}function c(e,t){var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){var n=e.target.result||\"\";if(r)return t(n);t(a(n))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function u(e,t){c(e,function(e){t(e)})}function f(e,t){u(e,function(e){t(p(e))})}function l(e,t){var n=new FileReader;n.onloadend=function(e){var n=e.target.result||new ArrayBuffer(0);t(n)},n.readAsArrayBuffer(e)}function d(){}Object.defineProperty(n,\"__esModule\",{value:!0});var h=function(e){return atob(e)},p=function(e){return btoa(e)};n.atob=h,n.btoa=p,n.base64StringToBlobOrBuffer=s,n.binaryStringToArrayBuffer=o,n.binaryStringToBlobOrBuffer=i,n.blob=r,n.blobOrBufferToBase64=f,n.blobOrBufferToBinaryString=u,n.readAsArrayBuffer=l,n.readAsBinaryString=c,n.typedBuffer=d},{}],19:[function(e,t,n){\"use strict\";function r(e){return f.scopeEval('\"use strict\";\\nreturn '+e+\";\",{})}function o(e){var t=[\"return function(doc) {\",'  \"use strict\";',\"  var emitted = false;\",\"  var emit = function (a, b) {\",\"    emitted = true;\",\"  };\",\"  var view = \"+e+\";\",\"  view(doc);\",\"  if (emitted) {\",\"    return true;\",\"  }\",\"};\"].join(\"\\n\");return f.scopeEval(t,{})}function i(e,t){if(e.selector&&e.filter&&\"_selector\"!==e.filter){var n=\"string\"==typeof e.filter?e.filter:\"function\";return t(new Error('selector invalid for filter \"'+n+'\"'))}t()}function s(e){e.view&&!e.filter&&(e.filter=\"_view\"),e.selector&&!e.filter&&(e.filter=\"_selector\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=f.normalizeDdocFunctionName(e.view):e.filter=f.normalizeDdocFunctionName(e.filter))}function a(e,t){return t.filter&&\"string\"==typeof t.filter&&!t.doc_ids&&!f.isRemote(e.db)}function c(e,t){var n=t.complete;if(\"_view\"===t.filter){if(!t.view||\"string\"!=typeof t.view){var i=l.createError(l.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return n(i)}var s=f.parseDdocFunctionName(t.view);e.db.get(\"_design/\"+s[0],function(r,i){if(e.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(l.generateErrorFromResponse(r));var a=i&&i.views&&i.views[s[1]]&&i.views[s[1]].map;if(!a)return n(l.createError(l.MISSING_DOC,i.views?\"missing json key: \"+s[1]:\"missing json key: views\"));t.filter=o(a),e.doChanges(t)})}else if(t.selector)t.filter=function(e){return d.matchesSelector(e,t.selector)},e.doChanges(t);else{var a=f.parseDdocFunctionName(t.filter);e.db.get(\"_design/\"+a[0],function(o,i){if(e.isCancelled)return n(null,{status:\"cancelled\"});if(o)return n(l.generateErrorFromResponse(o));var s=i&&i.filters&&i.filters[a[1]];if(!s)return n(l.createError(l.MISSING_DOC,i&&i.filters?\"missing json key: \"+a[1]:\"missing json key: filters\"));t.filter=r(s),e.doChanges(t)})}}function u(e){e._changesFilterPlugin={validate:i,normalize:s,shouldFilter:a,filter:c}}var f=e(36),l=e(24),d=e(35);t.exports=u},{24:24,35:35,36:36}],20:[function(e,t,n){\"use strict\";function r(e,t,n,o,i){return e.get(t).catch(function(n){if(404===n.status)return\"http\"!==e.adapter&&\"https\"!==e.adapter||u.explainError(404,\"PouchDB is just checking if a remote checkpoint exists.\"),{session_id:o,_id:t,history:[],replicator:d,version:l};throw n}).then(function(s){if(!i.cancelled&&s.last_seq!==n)return s.history=(s.history||[]).filter(function(e){return e.session_id!==o}),s.history.unshift({last_seq:n,session_id:o}),s.history=s.history.slice(0,h),s.version=l,s.replicator=d,s.session_id=o,s.last_seq=n,e.put(s).catch(function(s){if(409===s.status)return r(e,t,n,o,i);throw s})})}function o(e,t,n,r,o){this.src=e,this.target=t,this.id=n,this.returnValue=r,this.opts=o||{}}function i(e,t){return e.session_id===t.session_id?{last_seq:e.last_seq,history:e.history}:s(e.history,t.history)}function s(e,t){var n=e[0],r=e.slice(1),o=t[0],i=t.slice(1);return n&&0!==t.length?a(n.session_id,t)?{last_seq:n.last_seq,history:e}:a(o.session_id,r)?{last_seq:o.last_seq,history:i}:s(r,i):{last_seq:p,history:[]}}function a(e,t){var n=t[0],r=t.slice(1);return!(!e||0===t.length)&&(e===n.session_id||a(e,r))}function c(e){return\"number\"==typeof e.status&&4===Math.floor(e.status/100)}var u=e(36),f=e(21),l=1,d=\"pouchdb\",h=5,p=0;o.prototype.writeCheckpoint=function(e,t){var n=this;return this.updateTarget(e,t).then(function(){return n.updateSource(e,t)})},o.prototype.updateTarget=function(e,t){return this.opts.writeTargetCheckpoint?r(this.target,this.id,e,t,this.returnValue):Promise.resolve(!0)},o.prototype.updateSource=function(e,t){if(this.opts.writeSourceCheckpoint){var n=this;return r(this.src,this.id,e,t,this.returnValue).catch(function(e){if(c(e))return n.opts.writeSourceCheckpoint=!1,!0;throw e})}return Promise.resolve(!0)};var v={undefined:function(e,t){return 0===f.collate(e.last_seq,t.last_seq)?t.last_seq:0},1:function(e,t){return i(t,e).last_seq}};o.prototype.getCheckpoint=function(){var e=this;return e.opts&&e.opts.writeSourceCheckpoint&&!e.opts.writeTargetCheckpoint?e.src.get(e.id).then(function(e){return e.last_seq||p}).catch(function(e){if(404!==e.status)throw e;return p}):e.target.get(e.id).then(function(t){return e.opts&&e.opts.writeTargetCheckpoint&&!e.opts.writeSourceCheckpoint?t.last_seq||p:e.src.get(e.id).then(function(e){if(t.version!==e.version)return p;var n;return n=t.version?t.version.toString():\"undefined\",n in v?v[n](t,e):p},function(n){if(404===n.status&&t.last_seq)return e.src.put({_id:e.id,last_seq:p}).then(function(){return p},function(n){return c(n)?(e.opts.writeSourceCheckpoint=!1,t.last_seq):p});throw n})}).catch(function(e){if(404!==e.status)throw e;return p})},t.exports=o},{21:21,36:36}],21:[function(e,t,n){\"use strict\";function r(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}function o(e,t,n){return r(e,t,n)+e}function i(e,t){if(e===t)return 0;e=s(e),t=s(t);var n=v(e),r=v(t);if(n-r!=0)return n-r;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e<t?-1:1;case\"string\":return h(e,t)}return Array.isArray(e)?d(e,t):p(e,t)}function s(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var n=e.length;e=new Array(n);for(var r=0;r<n;r++)e[r]=s(t[r])}else{if(e instanceof Date)return e.toJSON();if(null!==e){e={};for(var o in t)if(t.hasOwnProperty(o)){var i=t[o];void 0!==i&&(e[o]=s(i))}}}}return e}function a(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return _(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),n=t?e:Object.keys(e),r=-1,o=n.length,i=\"\";if(t)for(;++r<o;)i+=c(n[r]);else for(;++r<o;){var s=n[r];i+=c(s)+c(e[s])}return i}return\"\"}function c(e){return e=s(e),v(e)+m+a(e)+\"\\0\"}function u(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var o=\"0\"===e[t];t++;var i=\"\",s=e.substring(t,t+y),a=parseInt(s,10)+g;for(o&&(a=-a),t+=y;;){var c=e[t];if(\"\\0\"===c)break;i+=c,t++}i=i.split(\".\"),n=1===i.length?parseInt(i,10):parseFloat(i[0]+\".\"+i[1]),o&&(n-=10),0!==a&&(n=parseFloat(n+\"e\"+a))}return{num:n,length:t-r}}function f(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(n);else if(i===e.length-2){var s=e.pop();o[s]=n}else e.push(n)}}function l(e){for(var t=[],n=[],r=0;;){var o=e[r++];if(\"\\0\"!==o)switch(o){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var i=u(e,r);t.push(i.num),r+=i.length;break;case\"4\":for(var s=\"\";;){var a=e[r];if(\"\\0\"===a)break;s+=a,r++}s=s.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(s);break;case\"5\":var c={element:[],index:t.length};t.push(c.element),n.push(c);break;case\"6\":var l={element:{},index:t.length};t.push(l.element),n.push(l);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+o)}else{if(1===t.length)return t.pop();f(t,n)}}}function d(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var o=i(e[r],t[r]);if(0!==o)return o}return e.length===t.length?0:e.length>t.length?1:-1}function h(e,t){return e===t?0:e>t?1:-1}function p(e,t){for(var n=Object.keys(e),r=Object.keys(t),o=Math.min(n.length,r.length),s=0;s<o;s++){var a=i(n[s],r[s]);if(0!==a)return a;if(0!==(a=i(e[n[s]],t[r[s]])))return a}return n.length===r.length?0:n.length>r.length?1:-1}function v(e){var t=[\"boolean\",\"number\",\"string\",\"object\"],n=t.indexOf(typeof e);return~n?null===e?1:Array.isArray(e)?5:n<3?n+2:n+3:Array.isArray(e)?5:void 0}function _(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,i=r?\"0\":\"2\",s=(r?-n:n)-g,a=o(s.toString(),\"0\",y);i+=m+a;var c=Math.abs(parseFloat(t[0]));r&&(c=10-c);var u=c.toFixed(20);return u=u.replace(/\\.?0+$/,\"\"),i+=m+u}Object.defineProperty(n,\"__esModule\",{value:!0});var g=-324,y=3,m=\"\";n.collate=i,n.normalizeKey=s,n.toIndexableString=c,n.parseIndexableString=l},{}],22:[function(e,t,n){\"use strict\";function r(e){return\"$\"+e}function o(e){return e.substring(1)}function i(){this._store={}}function s(e){if(this._store=new i,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),i.prototype.get=function(e){var t=r(e);return this._store[t]},i.prototype.set=function(e,t){var n=r(e);return this._store[n]=t,!0},i.prototype.has=function(e){return r(e)in this._store},i.prototype.delete=function(e){var t=r(e),n=t in this._store;return delete this._store[t],n},i.prototype.forEach=function(e){for(var t=Object.keys(this._store),n=0,r=t.length;n<r;n++){var i=t[n],s=this._store[i];i=o(i),e(s,i)}},Object.defineProperty(i.prototype,\"size\",{get:function(){return Object.keys(this._store).length}}),s.prototype.add=function(e){return this._store.set(e,!0)},s.prototype.has=function(e){return this._store.has(e)},s.prototype.forEach=function(e){this._store.forEach(function(t,n){e(n)})},Object.defineProperty(s.prototype,\"size\",{get:function(){return this._store.size}}),!function(){if(\"undefined\"==typeof Symbol||\"undefined\"==typeof Map||\"undefined\"==typeof Set)return!1;var e=Object.getOwnPropertyDescriptor(Map,Symbol.species);return e&&\"get\"in e&&Map[Symbol.species]===Map}()?(n.Set=s,n.Map=i):(n.Set=Set,n.Map=Map)},{}],23:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t,n,r){try{e.emit(\"change\",t,n,r)}catch(e){w.guardedConsole(\"error\",'Error in .on(\"change\", function):',e)}}function i(e,t,n){function r(){i.cancel()}S.EventEmitter.call(this);var i=this;this.db=e,t=t?w.clone(t):{};var s=t.complete=w.once(function(t,n){t?w.listenerCount(i,\"error\")>0&&i.emit(\"error\",t):i.emit(\"complete\",n),i.removeAllListeners(),e.removeListener(\"destroyed\",r)});n&&(i.on(\"complete\",function(e){n(null,e)}),i.on(\"error\",n)),e.once(\"destroyed\",r),t.onChange=function(e,t,n){i.isCancelled||o(i,e,t,n)};var a=new Promise(function(e,n){t.complete=function(t,r){t?n(t):e(r)}});i.once(\"cancel\",function(){e.removeListener(\"destroyed\",r),t.complete(null,{status:\"cancelled\"})}),this.then=a.then.bind(a),this.catch=a.catch.bind(a),this.then(function(e){s(null,e)},s),e.taskqueue.isReady?i.validateChanges(t):e.taskqueue.addTask(function(e){e?t.complete(e):i.isCancelled?i.emit(\"cancel\"):i.validateChanges(t)})}function s(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=k.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));var o={id:t.id,changes:r,doc:e};return k.isDeleted(t,e._rev)&&(o.deleted=!0),n.conflicts&&(o.doc._conflicts=k.collectConflicts(t),o.doc._conflicts.length||delete o.doc._conflicts),o}function a(e,t){return e<t?-1:e>t?1:0}function c(e,t){return function(n,r){n||r[0]&&r[0].error?(n=n||r[0],n.docId=t,e(n)):e(null,r.length?r[0]:r)}}function u(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),o=0;o<r.length;o++){var i=r[o];n._attachments[i]=w.pick(n._attachments[i],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}function f(e,t){var n=a(e._id,t._id);return 0!==n?n:a(e._revisions?e._revisions.start:0,t._revisions?t._revisions.start:0)}function l(e){var t={},n=[];return k.traverseRevTree(e,function(e,r,o,i){var s=r+\"-\"+o;return e&&(t[s]=0),void 0!==i&&n.push({from:i,to:s}),s}),n.reverse(),n.forEach(function(e){void 0===t[e.from]?t[e.from]=1+t[e.to]:t[e.from]=Math.min(t[e.from],1+t[e.to])}),t}function d(e){var t=\"limit\"in e?e.keys.slice(e.skip,e.limit+e.skip):e.skip>0?e.keys.slice(e.skip):e.keys;e.keys=t,e.skip=0,delete e.limit,e.descending&&(t.reverse(),e.descending=!1)}function h(e){var t=e._compactionQueue[0],n=t.opts,r=t.callback;e.get(\"_local/compaction\").catch(function(){return!1}).then(function(t){t&&t.last_seq&&(n.last_seq=t.last_seq),e._compact(n,function(t,n){t?r(t):r(null,n),w.nextTick(function(){e._compactionQueue.shift(),e._compactionQueue.length&&h(e)})})})}function p(e){return\"_\"===e.charAt(0)&&e+\" is not a valid attachment name, attachment names cannot start with '_'\"}function v(){S.EventEmitter.call(this);for(var e in v.prototype)\"function\"==typeof this[e]&&(this[e]=this[e].bind(this))}function _(){this.isReady=!1,this.failed=!1,this.queue=[]}function g(e,t){var n=e.match(/([a-z-]*):\\/\\/(.*)/);if(n)return{name:/https?/.test(n[1])?n[1]+\"://\"+n[2]:n[2],adapter:n[1]};var r=m.adapters,o=m.preferredAdapters,i=m.prefix,s=t.adapter;if(!s)for(var a=0;a<o.length;++a){s=o[a];{if(!(\"idb\"===s&&\"websql\"in r&&w.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+i+e]))break;w.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.')}}var c=r[s];return{name:c&&\"use_prefix\"in c&&!c.use_prefix?e:i+e,adapter:s}}function y(e){function t(t){e.removeListener(\"closed\",n),t||e.constructor.emit(\"destroyed\",e.name)}function n(){e.removeListener(\"destroyed\",t),e.constructor.emit(\"unref\",e)}e.once(\"destroyed\",t),e.once(\"closed\",n),e.constructor.emit(\"ref\",e)}function m(e,t){if(!(this instanceof m))return new m(e,t);var n=this;if(t=t||{},e&&\"object\"==typeof e&&(t=e,e=t.name,delete t.name),void 0===t.deterministic_revs&&(t.deterministic_revs=!0),this.__opts=t=w.clone(t),n.auto_compaction=t.auto_compaction,n.prefix=m.prefix,\"string\"!=typeof e)throw new Error(\"Missing/invalid DB name\");var r=(t.prefix||\"\")+e,o=g(r,t);if(t.name=o.name,t.adapter=t.adapter||o.adapter,n.name=e,n._adapter=t.adapter,m.emit(\"debug\",[\"adapter\",\"Picked adapter: \",t.adapter]),!m.adapters[t.adapter]||!m.adapters[t.adapter].valid())throw new Error(\"Invalid Adapter: \"+t.adapter);v.call(n),n.taskqueue=new _,n.adapter=t.adapter,m.adapters[t.adapter].call(n,t,function(e){if(e)return n.taskqueue.fail(e);y(n),n.emit(\"created\",n),m.emit(\"created\",n.name),n.taskqueue.ready(n)})}var b=r(e(7)),w=e(36),k=e(31),E=r(e(12)),S=e(10),O=e(22),A=e(24),I=e(25),j=r(e(19));E(i,S.EventEmitter),i.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},i.prototype.validateChanges=function(e){var t=e.complete,n=this;m._changesFilterPlugin?m._changesFilterPlugin.validate(e,function(r){if(r)return t(r);n.doChanges(e)}):n.doChanges(e)},i.prototype.doChanges=function(e){var t=this,n=e.complete;if(e=w.clone(e),\"live\"in e&&!(\"continuous\"in e)&&(e.continuous=e.live),e.processChange=s,\"latest\"===e.since&&(e.since=\"now\"),e.since||(e.since=0),\"now\"===e.since)return void this.db.info().then(function(r){if(t.isCancelled)return void n(null,{status:\"cancelled\"});e.since=r.update_seq,t.doChanges(e)},n);if(m._changesFilterPlugin){if(m._changesFilterPlugin.normalize(e),m._changesFilterPlugin.shouldFilter(this,e))return m._changesFilterPlugin.filter(this,e)}else[\"doc_ids\",\"filter\",\"selector\",\"view\"].forEach(function(t){t in e&&w.guardedConsole(\"warn\",'The \"'+t+'\" option was passed in to changes/replicate, but pouchdb-changes-filter plugin is not installed, so it was ignored. Please install the plugin to enable filtering.')});\"descending\"in e||(e.descending=!1),e.limit=0===e.limit?1:e.limit,e.complete=n;var r=this.db._changes(e);if(r&&\"function\"==typeof r.cancel){var o=t.cancel;t.cancel=b(function(e){r.cancel(),o.apply(this,e)})}},E(v,S.EventEmitter),v.prototype.post=w.adapterFun(\"post\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e))return n(A.createError(A.NOT_AN_OBJECT));this.bulkDocs({docs:[e]},t,c(n,e._id))}),v.prototype.put=w.adapterFun(\"put\",function(e,t,n){function r(n){\"function\"==typeof o._put&&!1!==t.new_edits?o._put(e,t,n):o.bulkDocs({docs:[e]},t,c(n,e._id))}if(\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e))return n(A.createError(A.NOT_AN_OBJECT));if(w.invalidIdError(e._id),k.isLocalId(e._id)&&\"function\"==typeof this._putLocal)return e._deleted?this._removeLocal(e,n):this._putLocal(e,n);var o=this;t.force&&e._rev?(!function(){var n=e._rev.split(\"-\"),r=n[1],o=parseInt(n[0],10),i=o+1,s=w.rev();e._revisions={start:i,ids:[s,r]},e._rev=i+\"-\"+s,t.new_edits=!1}(),r(function(t){var r=t?null:{ok:!0,id:e._id,rev:e._rev};n(t,r)})):r(n)}),v.prototype.putAttachment=w.adapterFun(\"putAttachment\",function(e,t,n,r,o){function i(e){var n=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[t]={content_type:o,data:r,revpos:++n},s.put(e)}var s=this;return\"function\"==typeof o&&(o=r,r=n,n=null),void 0===o&&(o=r,r=n,n=null),o||w.guardedConsole(\"warn\",\"Attachment\",t,\"on document\",e,\"is missing content_type\"),s.get(e).then(function(e){if(e._rev!==n)throw A.createError(A.REV_CONFLICT);return i(e)},function(t){if(t.reason===A.MISSING_DOC.message)return i({_id:e});throw t})}),v.prototype.removeAttachment=w.adapterFun(\"removeAttachment\",function(e,t,n,r){var o=this;o.get(e,function(e,i){return e?void r(e):i._rev!==n?void r(A.createError(A.REV_CONFLICT)):i._attachments?(delete i._attachments[t],0===Object.keys(i._attachments).length&&delete i._attachments,void o.put(i,r)):r()})}),v.prototype.remove=w.adapterFun(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,\"function\"==typeof t?(r=t,n={}):(r=n,n=t)),n=n||{},n.was_delete=!0;var i={_id:o._id,_rev:o._rev||n.rev};if(i._deleted=!0,k.isLocalId(i._id)&&\"function\"==typeof this._removeLocal)return this._removeLocal(o,r);this.bulkDocs({docs:[i]},n,c(r,i._id))}),v.prototype.revsDiff=w.adapterFun(\"revsDiff\",function(e,t,n){function r(e,t){a.has(e)||a.set(e,{missing:[]}),a.get(e).missing.push(t)}function o(t,n){var o=e[t].slice(0);k.traverseRevTree(n,function(e,n,i,s,a){var c=n+\"-\"+i,u=o.indexOf(c);-1!==u&&(o.splice(u,1),\"available\"!==a.status&&r(t,c))}),o.forEach(function(e){r(t,e)})}\"function\"==typeof t&&(n=t,t={});var i=Object.keys(e);if(!i.length)return n(null,{});var s=0,a=new O.Map;i.map(function(t){this._getRevisionTree(t,function(r,c){if(r&&404===r.status&&\"missing\"===r.message)a.set(t,{missing:e[t]});else{if(r)return n(r);o(t,c)}if(++s===i.length){var u={};return a.forEach(function(e,t){u[t]=e}),n(null,u)}})},this)}),v.prototype.bulkGet=w.adapterFun(\"bulkGet\",function(e,t){w.bulkGetShim(this,e,t)}),v.prototype.compactDocument=w.adapterFun(\"compactDocument\",function(e,t,n){var r=this;this._getRevisionTree(e,function(o,i){if(o)return n(o);var s=l(i),a=[],c=[];Object.keys(s).forEach(function(e){s[e]>t&&a.push(e)}),k.traverseRevTree(i,function(e,t,n,r,o){var i=t+\"-\"+n;\"available\"===o.status&&-1!==a.indexOf(i)&&c.push(i)}),r._doCompaction(e,c,n)})}),v.prototype.compact=w.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&h(n)}),v.prototype._compact=function(e,t){function n(e){s.push(o.compactDocument(e.id,0))}function r(e){var n=e.last_seq;Promise.all(s).then(function(){return w.upsert(o,\"_local/compaction\",function(e){return(!e.last_seq||e.last_seq<n)&&(e.last_seq=n,e)})}).then(function(){t(null,{ok:!0})}).catch(t)}var o=this,i={return_docs:!1,last_seq:e.last_seq||0},s=[];o.changes(i).on(\"change\",n).on(\"complete\",r).on(\"error\",t)},v.prototype.get=w.adapterFun(\"get\",function(e,t,n){function r(){var r=[],s=o.length;if(!s)return n(null,r);o.forEach(function(o){i.get(e,{rev:o,revs:t.revs,latest:t.latest,attachments:t.attachments,binary:t.binary},function(e,t){if(e)r.push({missing:o});else{for(var i,a=0,c=r.length;a<c;a++)if(r[a].ok&&r[a].ok._rev===t._rev){i=!0;break}i||r.push({ok:t})}--s||n(null,r)})})}if(\"function\"==typeof t&&(n=t,t={}),\"string\"!=typeof e)return n(A.createError(A.INVALID_ID));if(k.isLocalId(e)&&\"function\"==typeof this._getLocal)return this._getLocal(e,n);var o=[],i=this;if(!t.open_revs)return this._get(e,t,function(r,o){if(r)return r.docId=e,n(r);var s=o.doc,a=o.metadata,c=o.ctx;if(t.conflicts){var u=k.collectConflicts(a);u.length&&(s._conflicts=u)}if(k.isDeleted(a,s._rev)&&(s._deleted=!0),t.revs||t.revs_info){for(var f=s._rev.split(\"-\"),l=parseInt(f[0],10),d=f[1],h=k.rootToLeaf(a.rev_tree),p=null,v=0;v<h.length;v++){var _=h[v],g=_.ids.map(function(e){return e.id}).indexOf(d);(g===l-1||!p&&-1!==g)&&(p=_)}var y=p.ids.map(function(e){return e.id}).indexOf(s._rev.split(\"-\")[1])+1,m=p.ids.length-y;if(p.ids.splice(y,m),p.ids.reverse(),t.revs&&(s._revisions={start:p.pos+p.ids.length-1,ids:p.ids.map(function(e){return e.id})}),t.revs_info){var b=p.pos+p.ids.length;s._revs_info=p.ids.map(function(e){return b--,{rev:b+\"-\"+e.id,status:e.opts.status}})}}if(t.attachments&&s._attachments){var w=s._attachments,E=Object.keys(w).length;if(0===E)return n(null,s);Object.keys(w).forEach(function(e){this._getAttachment(s._id,e,w[e],{rev:s._rev,binary:t.binary,ctx:c},function(t,r){var o=s._attachments[e];o.data=r,delete o.stub,delete o.length,--E||n(null,s)})},i)}else{if(s._attachments)for(var S in s._attachments)s._attachments.hasOwnProperty(S)&&(s._attachments[S].stub=!0);n(null,s)}});if(\"all\"===t.open_revs)this._getRevisionTree(e,function(e,t){if(e)return n(e);o=k.collectLeaves(t).map(function(e){return e.rev}),r()});else{if(!Array.isArray(t.open_revs))return n(A.createError(A.UNKNOWN_ERROR,\"function_clause\"));o=t.open_revs;for(var s=0;s<o.length;s++){var a=o[s];if(\"string\"!=typeof a||!/^\\d+-/.test(a))return n(A.createError(A.INVALID_REV))}r()}}),v.prototype.getAttachment=w.adapterFun(\"getAttachment\",function(e,t,n,r){var o=this;n instanceof Function&&(r=n,n={}),this._get(e,n,function(i,s){return i?r(i):s.doc._attachments&&s.doc._attachments[t]?(n.ctx=s.ctx,n.binary=!0,o._getAttachment(e,t,s.doc._attachments[t],n,r),void 0):r(A.createError(A.MISSING_DOC))})}),v.prototype.allDocs=w.adapterFun(\"allDocs\",function(e,t){if(\"function\"==typeof e&&(t=e,e={}),e.skip=void 0!==e.skip?e.skip:0,e.start_key&&(e.startkey=e.start_key),e.end_key&&(e.endkey=e.end_key),\"keys\"in e){if(!Array.isArray(e.keys))return t(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(t){return t in e})[0];if(n)return void t(A.createError(A.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(!w.isRemote(this)&&(d(e),0===e.keys.length))return this._allDocs({limit:0},t)}return this._allDocs(e,t)}),v.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),e=e||{},e.return_docs=\"return_docs\"in e?e.return_docs:!e.live,new i(this,e,t)},v.prototype.close=w.adapterFun(\"close\",function(e){return this._closed=!0,this.emit(\"closed\"),this._close(e)}),v.prototype.info=w.adapterFun(\"info\",function(e){var t=this;this._info(function(n,r){if(n)return e(n);r.db_name=r.db_name||t.name,r.auto_compaction=!(!t.auto_compaction||w.isRemote(t)),r.adapter=t.adapter,e(null,r)})}),v.prototype.id=w.adapterFun(\"id\",function(e){return this._id(e)}),v.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},v.prototype.bulkDocs=w.adapterFun(\"bulkDocs\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),t=t||{},Array.isArray(e)&&(e={docs:e}),!e||!e.docs||!Array.isArray(e.docs))return n(A.createError(A.MISSING_BULK_DOCS));for(var r=0;r<e.docs.length;++r)if(\"object\"!=typeof e.docs[r]||Array.isArray(e.docs[r]))return n(A.createError(A.NOT_AN_OBJECT));var o;if(e.docs.forEach(function(e){e._attachments&&Object.keys(e._attachments).forEach(function(t){o=o||p(t),e._attachments[t].content_type||w.guardedConsole(\"warn\",\"Attachment\",t,\"on document\",e._id,\"is missing content_type\")})}),o)return n(A.createError(A.BAD_REQUEST,o));\"new_edits\"in t||(t.new_edits=!(\"new_edits\"in e)||e.new_edits);var i=this;t.new_edits||w.isRemote(i)||e.docs.sort(f),u(e.docs);var s=e.docs.map(function(e){return e._id});return this._bulkDocs(e,t,function(e,r){if(e)return n(e);if(t.new_edits||(r=r.filter(function(e){return e.error})),!w.isRemote(i))for(var o=0,a=r.length;o<a;o++)r[o].id=r[o].id||s[o];n(null,r)})}),v.prototype.registerDependentDatabase=w.adapterFun(\"registerDependentDatabase\",function(e,t){function n(t){return t.dependentDbs=t.dependentDbs||{},!t.dependentDbs[e]&&(t.dependentDbs[e]=!0,t)}var r=new this.constructor(e,this.__opts);w.upsert(this,\"_local/_pouch_dependentDbs\",n).then(function(){t(null,{db:r})}).catch(t)}),v.prototype.destroy=w.adapterFun(\"destroy\",function(e,t){function n(){r._destroy(e,function(e,n){if(e)return t(e);r._destroyed=!0,r.emit(\"destroyed\"),t(null,n||{ok:!0})})}\"function\"==typeof e&&(t=e,e={});var r=this,o=!(\"use_prefix\"in r)||r.use_prefix;if(w.isRemote(r))return n();r.get(\"_local/_pouch_dependentDbs\",function(e,i){if(e)return 404!==e.status?t(e):n();var s=i.dependentDbs,a=r.constructor,c=Object.keys(s).map(function(e){var t=o?e.replace(new RegExp(\"^\"+a.prefix),\"\"):e;return new a(t,r.__opts).destroy()});Promise.all(c).then(n,t)})}),_.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},_.prototype.fail=function(e){this.failed=e,this.execute()},_.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},_.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},E(m,v),m.adapters={},m.preferredAdapters=[],m.prefix=\"_pouch_\";var D=new S.EventEmitter;!function(e){Object.keys(S.EventEmitter.prototype).forEach(function(t){\"function\"==typeof S.EventEmitter.prototype[t]&&(e[t]=D[t].bind(D))});var t=e._destructionListeners=new O.Map;e.on(\"ref\",function(e){t.has(e.name)||t.set(e.name,[]),t.get(e.name).push(e)}),e.on(\"unref\",function(e){if(t.has(e.name)){var n=t.get(e.name),r=n.indexOf(e);r<0||(n.splice(r,1),n.length>1?t.set(e.name,n):t.delete(e.name))}}),e.on(\"destroyed\",function(e){if(t.has(e)){var n=t.get(e);t.delete(e),n.forEach(function(e){e.emit(\"destroyed\",!0)})}})}(m),m.adapter=function(e,t,n){t.valid()&&(m.adapters[e]=t,n&&m.preferredAdapters.push(e))},m.plugin=function(e){if(\"function\"==typeof e)e(m);else{if(\"object\"!=typeof e||0===Object.keys(e).length)throw new Error('Invalid plugin: got \"'+e+'\", expected an object or a function');Object.keys(e).forEach(function(t){m.prototype[t]=e[t]})}return this.__defaults&&(m.__defaults=w.assign({},this.__defaults)),m},m.defaults=function(e){function t(e,n){if(!(this instanceof t))return new t(e,n);n=n||{},e&&\"object\"==typeof e&&(n=e,e=n.name,delete n.name),n=w.assign({},t.__defaults,n),m.call(this,e,n)}return E(t,m),t.preferredAdapters=m.preferredAdapters.slice(),Object.keys(m).forEach(function(e){e in t||(t[e]=m[e])}),t.__defaults=w.assign({},this.__defaults,e),t},m.fetch=function(e,t){return I.fetch(e,t)};m.plugin(j),m.version=\"7.0.0\",t.exports=m},{10:10,12:12,19:19,22:22,24:24,25:25,31:31,36:36,7:7}],24:[function(e,t,n){\"use strict\";function r(e,t,n){Error.call(this,n),this.status=e,this.name=t,this.message=n,this.error=!0}function o(e,t){function n(t){for(var n in e)\"function\"!=typeof e[n]&&(this[n]=e[n]);void 0!==t&&(this.reason=t)}return n.prototype=r.prototype,new n(t)}function i(e){if(\"object\"!=typeof e){var t=e;e=p,e.data=t}return\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}Object.defineProperty(n,\"__esModule\",{value:!0}),function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(12))(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var s=new r(401,\"unauthorized\",\"Name or password is incorrect.\"),a=new r(400,\"bad_request\",\"Missing JSON list of 'docs'\"),c=new r(404,\"not_found\",\"missing\"),u=new r(409,\"conflict\",\"Document update conflict\"),f=new r(400,\"bad_request\",\"_id field must contain a string\"),l=new r(412,\"missing_id\",\"_id is required for puts\"),d=new r(400,\"bad_request\",\"Only reserved document ids may start with underscore.\"),h=new r(412,\"precondition_failed\",\"Database not open\"),p=new r(500,\"unknown_error\",\"Database encountered an unknown error\"),v=new r(500,\"badarg\",\"Some query argument is invalid\"),_=new r(400,\"invalid_request\",\"Request was invalid\"),g=new r(400,\"query_parse_error\",\"Some query parameter is invalid\"),y=new r(500,\"doc_validation\",\"Bad special document member\"),m=new r(400,\"bad_request\",\"Something wrong with the request\"),b=new r(400,\"bad_request\",\"Document must be a JSON object\"),w=new r(404,\"not_found\",\"Database not found\"),k=new r(500,\"indexed_db_went_bad\",\"unknown\"),E=new r(500,\"web_sql_went_bad\",\"unknown\"),S=new r(500,\"levelDB_went_went_bad\",\"unknown\"),O=new r(403,\"forbidden\",\"Forbidden by design doc validate_doc_update function\"),A=new r(400,\"bad_request\",\"Invalid rev format\"),I=new r(412,\"file_exists\",\"The database could not be created, the file already exists.\"),j=new r(412,\"missing_stub\",\"A pre-existing attachment stub wasn't found\"),D=new r(413,\"invalid_url\",\"Provided URL is invalid\");n.UNAUTHORIZED=s,n.MISSING_BULK_DOCS=a,n.MISSING_DOC=c,n.REV_CONFLICT=u,n.INVALID_ID=f,n.MISSING_ID=l,n.RESERVED_ID=d,n.NOT_OPEN=h,n.UNKNOWN_ERROR=p,n.BAD_ARG=v,n.INVALID_REQUEST=_,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=y,n.BAD_REQUEST=m,n.NOT_AN_OBJECT=b,n.DB_MISSING=w,n.WSQ_ERROR=E,n.LDB_ERROR=S,n.FORBIDDEN=O,n.INVALID_REV=A,n.FILE_EXISTS=I,n.MISSING_STUB=j,n.IDB_ERROR=k,n.INVALID_URL=D,n.createError=o,n.generateErrorFromResponse=i},{12:12}],25:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var r=\"undefined\"!=typeof AbortController?AbortController:function(){return{abort:function(){}}},o=fetch,i=Headers;n.fetch=o,n.Headers=i,n.AbortController=r},{}],26:[function(e,t,n){\"use strict\";function r(e){return Object.keys(e).sort(s.collate).reduce(function(t,n){return t[n]=e[n],t},{})}function o(e,t,n){var o=n.doc_ids?n.doc_ids.sort(s.collate):\"\",a=n.filter?n.filter.toString():\"\",c=\"\",u=\"\",f=\"\";return n.selector&&(f=JSON.stringify(n.selector)),\nn.filter&&n.query_params&&(c=JSON.stringify(r(n.query_params))),n.filter&&\"_view\"===n.filter&&(u=n.view.toString()),Promise.all([e.id(),t.id()]).then(function(e){var t=e[0]+e[1]+a+u+c+o+f;return new Promise(function(e){i.binaryMd5(t,e)})}).then(function(e){return\"_local/\"+(e=e.replace(/\\//g,\".\").replace(/\\+/g,\"_\"))})}var i=e(30),s=e(21);t.exports=o},{21:21,30:30}],27:[function(e,t,n){\"use strict\";function r(e){try{return JSON.parse(e)}catch(t){return i.parse(e)}}function o(e){try{return JSON.stringify(e)}catch(t){return i.stringify(e)}}Object.defineProperty(n,\"__esModule\",{value:!0});var i=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(44));n.safeJsonParse=r,n.safeJsonStringify=o},{44:44}],28:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,o)}catch(e){}}function i(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,i)}catch(e){}}function s(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,s)}catch(e){}}function a(e,t){return t&&e.then(function(e){_.nextTick(function(){t(null,e)})},function(e){_.nextTick(function(){t(e)})}),e}function c(e){return v(function(t){var n=t.pop(),r=e.apply(this,t);return\"function\"==typeof n&&a(r,n),r})}function u(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})}function f(e,t){return function(){var n=arguments,r=this;return e.add(function(){return t.apply(r,n)})}}function l(e){var t=new p.Set(e),n=new Array(t.size),r=-1;return t.forEach(function(e){n[++r]=e}),n}function d(e){var t=new Array(e.size),n=-1;return e.forEach(function(e,r){t[++n]=r}),t}Object.defineProperty(n,\"__esModule\",{value:!0});var h=r(e(12)),p=e(22),v=r(e(7)),_=e(36);h(o,Error),h(i,Error),h(s,Error),n.uniq=l,n.sequentialize=f,n.fin=u,n.callbackify=c,n.promisedCallback=a,n.mapToKeysArray=d,n.QueryParseError=o,n.NotFoundError=i,n.BuiltInError=s},{12:12,22:22,36:36,7:7}],29:[function(e,t,n){\"use strict\";function r(e){var t=\"builtin \"+e+\" function requires map values to be numbers or number arrays\";return new d.BuiltInError(t)}function o(e){for(var t=0,n=0,o=e.length;n<o;n++){var i=e[n];if(\"number\"!=typeof i){if(!Array.isArray(i))throw r(\"_sum\");t=\"number\"==typeof t?[t]:t;for(var s=0,a=i.length;s<a;s++){var c=i[s];if(\"number\"!=typeof c)throw r(\"_sum\");void 0===t[s]?t.push(c):t[s]+=c}}else\"number\"==typeof t?t+=i:t[0]+=i}return t}function i(e,t){return h.scopeEval(\"return (\"+e.replace(/;\\s*$/,\"\")+\");\",{emit:t,sum:o,log:v,isArray:_,toJSON:g})}function s(e){if(/^_sum/.test(e))return y._sum;if(/^_count/.test(e))return y._count;if(/^_stats/.test(e))return y._stats;if(/^_/.test(e))throw new Error(e+\" is not a supported reduce function.\")}function a(e,t){if(\"function\"==typeof e&&2===e.length){var n=e;return function(e){return n(e,t)}}return i(e.toString(),t)}function c(e){var t=e.toString(),n=s(t);return n||i(t)}function u(e,t){var n=e.views&&e.views[t];if(\"string\"!=typeof n.map)throw new d.NotFoundError(\"ddoc \"+e._id+\" has no string view named \"+t+\", instead found object of type: \"+typeof n.map)}function f(e,t,n){return m.query.call(this,e,t,n)}function l(e){return m.viewCleanup.call(this,e)}var d=e(28),h=e(36),p=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(14)),v=h.guardedConsole.bind(null,\"log\"),_=Array.isArray,g=JSON.parse,y={_sum:function(e,t){return o(t)},_count:function(e,t){return t.length},_stats:function(e,t){return{sum:o(t),min:Math.min.apply(null,t),max:Math.max.apply(null,t),count:t.length,sumsqr:function(e){for(var t=0,n=0,r=e.length;n<r;n++){var o=e[n];t+=o*o}return t}(t)}}},m=p(\"mrviews\",a,c,u),b={query:f,viewCleanup:l};t.exports=b},{14:14,28:28,36:36}],30:[function(e,t,n){(function(t){\"use strict\";function r(e){return u.btoa(e)}function o(e,t,n){return e.webkitSlice?e.webkitSlice(t,n):e.slice(t,n)}function i(e,t,n,r,i){(n>0||r<t.size)&&(t=o(t,n,r)),u.readAsArrayBuffer(t,function(t){e.append(t),i()})}function s(e,t,n,r,o){(n>0||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}function a(e,t){function n(){l(a)}function o(){var e=_.end(!0),n=r(e);t(n),_.destroy()}function a(){var t=v*h,r=t+h;v++,v<p?g(_,e,t,r,n):g(_,e,t,r,o)}var c=\"string\"==typeof e,u=c?e.length:e.size,h=Math.min(d,u),p=Math.ceil(u/h),v=0,_=c?new f:new f.ArrayBuffer,g=c?s:i;a()}function c(e){return f.hash(e)}Object.defineProperty(n,\"__esModule\",{value:!0});var u=e(18),f=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(38)),l=t.setImmediate||t.setTimeout,d=32768;n.binaryMd5=a,n.stringMd5=c}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{18:18,38:38}],31:[function(e,t,n){\"use strict\";function r(e){for(var t,n,r,o,i=e.rev_tree.slice();o=i.pop();){var s=o.ids,a=s[2],c=o.pos;if(a.length)for(var u=0,f=a.length;u<f;u++)i.push({pos:c+1,ids:a[u]});else{var l=!!s[1].deleted,d=s[0];t&&!(r!==l?r:n!==c?n<c:t<d)||(t=d,n=c,r=l)}}return n+\"-\"+t}function o(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,i=n.ids,s=i[2],a=t(0===s.length,o,i[0],n.ctx,i[1]),c=0,u=s.length;c<u;c++)r.push({pos:o+1,ids:s[c],ctx:a})}function i(e,t){return e.pos-t.pos}function s(e){var t=[];o(e,function(e,n,r,o,i){e&&t.push({rev:n+\"-\"+r,pos:n,opts:i})}),t.sort(i).reverse();for(var n=0,r=t.length;n<r;n++)delete t[n].pos;return t}function a(e){for(var t=r(e),n=s(e.rev_tree),o=[],i=0,a=n.length;i<a;i++){var c=n[i];c.rev===t||c.opts.deleted||o.push(c.rev)}return o}function c(e){var t=[];return o(e.rev_tree,function(e,n,r,o,i){\"available\"!==i.status||e||(t.push(n+\"-\"+r),i.status=\"missing\")}),t}function u(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,i=t.ids,s=i[0],a=i[1],c=i[2],u=0===c.length,f=t.history?t.history.slice():[];f.push({id:s,opts:a}),u&&n.push({pos:o+1-f.length,ids:f});for(var l=0,d=c.length;l<d;l++)r.push({pos:o+1,ids:c[l],history:f})}return n.reverse()}function f(e,t){return e.pos-t.pos}function l(e,t,n){for(var r,o=0,i=e.length;o<i;)r=o+i>>>1,n(e[r],t)<0?o=r+1:i=r;return o}function d(e,t,n){var r=l(e,t,n);e.splice(r,0,t)}function h(e,t){for(var n,r,o=t,i=e.length;o<i;o++){var s=e[o],a=[s.id,s.opts,[]];r?(r[2].push(a),r=a):n=r=a}return n}function p(e,t){return e[0]<t[0]?-1:1}function v(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;n.length>0;){var o=n.pop(),i=o.tree1,s=o.tree2;(i[1].status||s[1].status)&&(i[1].status=\"available\"===i[1].status||\"available\"===s[1].status?\"available\":\"missing\");for(var a=0;a<s[2].length;a++)if(i[2][0]){for(var c=!1,u=0;u<i[2].length;u++)i[2][u][0]===s[2][a][0]&&(n.push({tree1:i[2][u],tree2:s[2][a]}),c=!0);c||(r=\"new_branch\",d(i[2],s[2][a],p))}else r=\"new_leaf\",i[2][0]=s[2][a]}return{conflicts:r,tree:e}}function _(e,t,n){var r,o=[],i=!1,s=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var a=0,c=e.length;a<c;a++){var u=e[a];if(u.pos===t.pos&&u.ids[0]===t.ids[0])r=v(u.ids,t.ids),o.push({pos:u.pos,ids:r.tree}),i=i||r.conflicts,s=!0;else if(!0!==n){var l=u.pos<t.pos?u:t,d=u.pos<t.pos?t:u,h=d.pos-l.pos,p=[],_=[];for(_.push({ids:l.ids,diff:h,parent:null,parentIdx:null});_.length>0;){var g=_.pop();if(0!==g.diff)for(var y=g.ids[2],m=0,b=y.length;m<b;m++)_.push({ids:y[m],diff:g.diff-1,parent:g.ids,parentIdx:m});else g.ids[0]===d.ids[0]&&p.push(g)}var w=p[0];w?(r=v(w.ids,d.ids),w.parent[2][w.parentIdx]=r.tree,o.push({pos:l.pos,ids:l.ids}),i=i||r.conflicts,s=!0):o.push(u)}else o.push(u)}return s||o.push(t),o.sort(f),{tree:o,conflicts:i||\"internal_node\"}}function g(e,t){for(var n,r,i=u(e),s=0,a=i.length;s<a;s++){var c,f=i[s],l=f.ids;if(l.length>t){n||(n={});var d=l.length-t;c={pos:f.pos+d,ids:h(l,d)};for(var p=0;p<d;p++){var v=f.pos+p+\"-\"+l[p].id;n[v]=!0}}else c={pos:f.pos,ids:h(l,0)};r=r?_(r,c,!0).tree:[c]}return n&&o(r,function(e,t,r){delete n[t+\"-\"+r]}),{tree:r,revs:n?Object.keys(n):[]}}function y(e,t,n){var r=_(e,t),o=g(r.tree,n);return{tree:o.tree,stemmedRevs:o.revs,conflicts:r.conflicts}}function m(e,t){for(var n,r=e.slice(),o=t.split(\"-\"),i=parseInt(o[0],10),s=o[1];n=r.pop();){if(n.pos===i&&n.ids[0]===s)return!0;for(var a=n.ids[2],c=0,u=a.length;c<u;c++)r.push({pos:n.pos+1,ids:a[c]})}return!1}function b(e){return e.ids}function w(e,t){t||(t=r(e));for(var n,o=t.substring(t.indexOf(\"-\")+1),i=e.rev_tree.map(b);n=i.pop();){if(n[0]===o)return!!n[1].deleted;i=i.concat(n[2])}}function k(e){return/^_local/.test(e)}function E(e,t){for(var n,r=t.rev_tree.slice();n=r.pop();){var o=n.pos,i=n.ids,s=i[0],a=i[1],c=i[2],u=0===c.length,f=n.history?n.history.slice():[];if(f.push({id:s,pos:o,opts:a}),u)for(var l=0,d=f.length;l<d;l++){var h=f[l],p=h.pos+\"-\"+h.id;if(p===e)return o+\"-\"+s}for(var v=0,_=c.length;v<_;v++)r.push({pos:o+1,ids:c[v],history:f})}throw new Error(\"Unable to resolve latest revision for id \"+t.id+\", rev \"+e)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=a,n.collectLeaves=s,n.compactTree=c,n.isDeleted=w,n.isLocalId=k,n.merge=y,n.revExists=m,n.rootToLeaf=u,n.traverseRevTree=o,n.winningRev=r,n.latest=E},{}],32:[function(e,t,n){\"use strict\";var r=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(33)),o=\"function\"==typeof Promise?Promise:r;t.exports=o},{33:33}],33:[function(e,t,n){\"use strict\";function r(){}function o(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=y,this.queue=[],this.outcome=void 0,e!==r&&c(this,e)}function i(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function s(e,t,n){p(function(){var r;try{r=t(n)}catch(t){return v.reject(e,t)}r===e?v.reject(e,new TypeError(\"Cannot resolve promise with itself\")):v.resolve(e,r)})}function a(e){var t=e&&e.then;if(e&&(\"object\"==typeof e||\"function\"==typeof e)&&\"function\"==typeof t)return function(){t.apply(e,arguments)}}function c(e,t){function n(t){i||(i=!0,v.reject(e,t))}function r(t){i||(i=!0,v.resolve(e,t))}function o(){t(r,n)}var i=!1,s=u(o);\"error\"===s.status&&n(s.value)}function u(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(e){n.status=\"error\",n.value=e}return n}function f(e){return e instanceof this?e:v.resolve(new this(r),e)}function l(e){var t=new this(r);return v.reject(t,e)}function d(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=new Array(n),s=0,a=-1,c=new this(r);++a<n;)!function(e,r){function a(e){i[r]=e,++s!==n||o||(o=!0,v.resolve(c,i))}t.resolve(e).then(a,function(e){o||(o=!0,v.reject(c,e))})}(e[a],a);return c}function h(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=-1,s=new this(r);++i<n;)!function(e){t.resolve(e).then(function(e){o||(o=!0,v.resolve(s,e))},function(e){o||(o=!0,v.reject(s,e))})}(e[i]);return s}var p=e(11),v={},_=[\"REJECTED\"],g=[\"FULFILLED\"],y=[\"PENDING\"];t.exports=o,o.prototype.catch=function(e){return this.then(null,e)},o.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===g||\"function\"!=typeof t&&this.state===_)return this;var n=new this.constructor(r);if(this.state!==y){s(n,this.state===g?e:t,this.outcome)}else this.queue.push(new i(n,e,t));return n},i.prototype.callFulfilled=function(e){v.resolve(this.promise,e)},i.prototype.otherCallFulfilled=function(e){s(this.promise,this.onFulfilled,e)},i.prototype.callRejected=function(e){v.reject(this.promise,e)},i.prototype.otherCallRejected=function(e){s(this.promise,this.onRejected,e)},v.resolve=function(e,t){var n=u(a,t);if(\"error\"===n.status)return v.reject(e,n.value);var r=n.value;if(r)c(e,r);else{e.state=g,e.outcome=t;for(var o=-1,i=e.queue.length;++o<i;)e.queue[o].callFulfilled(t)}return e},v.reject=function(e,t){e.state=_,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},o.resolve=f,o.reject=l,o.all=d,o.race=h},{11:11}],34:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return/^1-/.test(e)}function i(e,t,n){return!e._attachments||!e._attachments[n]||e._attachments[n].digest!==t._attachments[n].digest}function s(e,t){var n=Object.keys(t._attachments);return Promise.all(n.map(function(n){return e.getAttachment(t._id,n,{rev:t._rev})}))}function a(e,t,n){var r=y.isRemote(t)&&!y.isRemote(e),o=Object.keys(n._attachments);return r?e.get(n._id).then(function(r){return Promise.all(o.map(function(o){return i(r,n,o)?t.getAttachment(n._id,o):e.getAttachment(r._id,o)}))}).catch(function(e){if(404!==e.status)throw e;return s(t,n)}):s(t,n)}function c(e){var t=[];return Object.keys(e).forEach(function(n){e[n].missing.forEach(function(e){t.push({id:n,rev:e})})}),{docs:t,revs:!0,latest:!0}}function u(e,t,n,r){function i(){var o=c(n);if(o.docs.length)return e.bulkGet(o).then(function(n){if(r.cancelled)throw new Error(\"cancelled\");return Promise.all(n.results.map(function(n){return Promise.all(n.docs.map(function(n){var r=n.ok;return n.error&&(p=!1),r&&r._attachments?a(t,e,r).then(function(e){var t=Object.keys(r._attachments);return e.forEach(function(e,n){var o=r._attachments[t[n]];delete o.stub,delete o.length,o.data=e}),r}):r}))})).then(function(e){h=h.concat(y.flatten(e).filter(Boolean))})})}function s(e){return e._attachments&&Object.keys(e._attachments).length>0}function u(e){return e._conflicts&&e._conflicts.length>0}function f(t){return e.allDocs({keys:t,include_docs:!0,conflicts:!0}).then(function(e){if(r.cancelled)throw new Error(\"cancelled\");e.rows.forEach(function(e){e.deleted||!e.doc||!o(e.value.rev)||s(e.doc)||u(e.doc)||(e.doc._conflicts&&delete e.doc._conflicts,h.push(e.doc),delete n[e.id])})})}function l(){var e=Object.keys(n).filter(function(e){var t=n[e].missing;return 1===t.length&&o(t[0])});if(e.length>0)return f(e)}function d(){return{ok:p,docs:h}}n=y.clone(n);var h=[],p=!0;return Promise.resolve().then(l).then(i).then(d)}function f(e,t,n,r){if(!1===e.retry)return t.emit(\"error\",n),void t.removeAllListeners();if(\"function\"!=typeof e.back_off_function&&(e.back_off_function=y.defaultBackOff),t.emit(\"requestError\",n),\"active\"===t.state||\"pending\"===t.state){t.emit(\"paused\",n),t.state=\"stopped\";var o=function(){e.current_back_off=S},i=function(){t.removeListener(\"active\",o)};t.once(\"paused\",i),t.once(\"active\",o)}e.current_back_off=e.current_back_off||S,e.current_back_off=e.back_off_function(e.current_back_off),setTimeout(r,e.current_back_off)}function l(e,t,n,r,o){function i(){return D?Promise.resolve():b(e,t,n).then(function(o){j=o;var i={};i=!1===n.checkpoint?{writeSourceCheckpoint:!1,writeTargetCheckpoint:!1}:\"source\"===n.checkpoint?{writeSourceCheckpoint:!0,writeTargetCheckpoint:!1}:\"target\"===n.checkpoint?{writeSourceCheckpoint:!1,writeTargetCheckpoint:!0}:{writeSourceCheckpoint:!0,writeTargetCheckpoint:!0},D=new m(e,t,j,r,i)})}function s(){if(U=[],0!==I.docs.length){var e=I.docs,i={timeout:n.timeout};return t.bulkDocs({docs:e,new_edits:!1},i).then(function(t){if(r.cancelled)throw _(),new Error(\"cancelled\");var n=Object.create(null);t.forEach(function(e){e.error&&(n[e.id]=e)});var i=Object.keys(n).length;o.doc_write_failures+=i,o.docs_written+=e.length-i,e.forEach(function(e){var t=n[e._id];if(t){o.errors.push(t);var i=(t.name||\"\").toLowerCase();if(\"unauthorized\"!==i&&\"forbidden\"!==i)throw t;r.emit(\"denied\",y.clone(t))}else U.push(e)})},function(t){throw o.doc_write_failures+=e.length,t})}}function a(){if(I.error)throw new Error(\"There was a problem getting docs.\");o.last_seq=L=I.seq;var e=y.clone(o);return U.length&&(e.docs=U,\"number\"==typeof I.pending&&(e.pending=I.pending,delete I.pending),r.emit(\"change\",e)),C=!0,D.writeCheckpoint(I.seq,K).then(function(){if(C=!1,r.cancelled)throw _(),new Error(\"cancelled\");I=void 0,S()}).catch(function(e){throw A(e),e})}function c(){var e={};return I.changes.forEach(function(t){\"_user/\"!==t.id&&(e[t.id]=t.changes.map(function(e){return e.rev}))}),t.revsDiff(e).then(function(e){if(r.cancelled)throw _(),new Error(\"cancelled\");I.diffs=e})}function d(){return u(e,t,I.diffs,r).then(function(e){I.error=!e.ok,e.docs.forEach(function(e){delete I.diffs[e._id],o.docs_read++,I.docs.push(e)})})}function h(){if(!r.cancelled&&!I){if(0===q.length)return void p(!0);I=q.shift(),c().then(d).then(s).then(a).then(h).catch(function(e){v(\"batch processing terminated with error\",e)})}}function p(e){if(0===x.changes.length)return void(0!==q.length||I||((B&&J.live||R)&&(r.state=\"pending\",r.emit(\"paused\")),R&&_()));(e||R||x.changes.length>=P)&&(q.push(x),x={seq:0,changes:[],docs:[]},\"pending\"!==r.state&&\"stopped\"!==r.state||(r.state=\"active\",r.emit(\"active\")),h())}function v(e,t){T||(t.message||(t.message=e),o.ok=!1,o.status=\"aborting\",q=[],x={seq:0,changes:[],docs:[]},_(t))}function _(i){if(!(T||r.cancelled&&(o.status=\"cancelled\",C)))if(o.status=o.status||\"complete\",o.end_time=(new Date).toISOString(),o.last_seq=L,T=!0,i){i=w.createError(i),i.result=o;var s=(i.name||\"\").toLowerCase();\"unauthorized\"===s||\"forbidden\"===s?(r.emit(\"error\",i),r.removeAllListeners()):f(n,r,i,function(){l(e,t,n,r)})}else r.emit(\"complete\",o),r.removeAllListeners()}function g(e,t,o){if(r.cancelled)return _();\"number\"==typeof t&&(x.pending=t),y.filterChange(n)(e)&&(x.seq=e.seq||o,x.changes.push(e),y.nextTick(function(){p(0===q.length&&J.live)}))}function k(e){if(M=!1,r.cancelled)return _();if(e.results.length>0)J.since=e.results[e.results.length-1].seq,S(),p(!0);else{var t=function(){B?(J.live=!0,S()):R=!0,p(!0)};I||0!==e.results.length?t():(C=!0,D.writeCheckpoint(e.last_seq,K).then(function(){C=!1,o.last_seq=L=e.last_seq,t()}).catch(A))}}function E(e){if(M=!1,r.cancelled)return _();v(\"changes rejected\",e)}function S(){function t(){i.cancel()}function o(){r.removeListener(\"cancel\",t)}if(!M&&!R&&q.length<N){M=!0,r._changes&&(r.removeListener(\"cancel\",r._abortChanges),r._changes.cancel()),r.once(\"cancel\",t);var i=e.changes(J).on(\"change\",g);i.then(o,o),i.then(k).catch(E),n.retry&&(r._changes=i,r._abortChanges=t)}}function O(){i().then(function(){return r.cancelled?void _():D.getCheckpoint().then(function(e){L=e,J={since:L,limit:P,batch_size:P,style:\"all_docs\",doc_ids:$,selector:F,return_docs:!0},n.filter&&(\"string\"!=typeof n.filter?J.include_docs=!0:J.filter=n.filter),\"heartbeat\"in n&&(J.heartbeat=n.heartbeat),\"timeout\"in n&&(J.timeout=n.timeout),n.query_params&&(J.query_params=n.query_params),n.view&&(J.view=n.view),S()})}).catch(function(e){v(\"getCheckpoint rejected with \",e)})}function A(e){C=!1,v(\"writeCheckpoint completed with error\",e)}var I,j,D,q=[],x={seq:0,changes:[],docs:[]},C=!1,R=!1,T=!1,L=0,B=n.continuous||n.live||!1,P=n.batch_size||100,N=n.batches_limit||10,M=!1,$=n.doc_ids,F=n.selector,U=[],K=y.uuid();o=o||{ok:!0,start_time:(new Date).toISOString(),docs_read:0,docs_written:0,doc_write_failures:0,errors:[]};var J={};if(r.ready(e,t),r.cancelled)return void _();r._addedListeners||(r.once(\"cancel\",_),\"function\"==typeof n.complete&&(r.once(\"error\",n.complete),r.once(\"complete\",function(e){n.complete(null,e)})),r._addedListeners=!0),void 0===n.since?O():i().then(function(){return C=!0,D.writeCheckpoint(n.since,K)}).then(function(){if(C=!1,r.cancelled)return void _();L=n.since,O()}).catch(A)}function d(){k.EventEmitter.call(this),this.cancelled=!1,this.state=\"pending\";var e=this,t=new Promise(function(t,n){e.once(\"complete\",t),e.once(\"error\",n)});e.then=function(e,n){return t.then(e,n)},e.catch=function(e){return t.catch(e)},e.catch(function(){})}function h(e,t){var n=t.PouchConstructor;return\"string\"==typeof e?new n(e,t):e}function p(e,t,n,r){if(\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n.doc_ids&&!Array.isArray(n.doc_ids))throw w.createError(w.BAD_REQUEST,\"`doc_ids` filter parameter is not a list.\");n.complete=r,n=y.clone(n),n.continuous=n.continuous||n.live,n.retry=\"retry\"in n&&n.retry,n.PouchConstructor=n.PouchConstructor||this;var o=new d(n);return l(h(e,n),h(t,n),n,o),o}function v(e,t,n,r){return\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n=y.clone(n),n.PouchConstructor=n.PouchConstructor||this,e=h(e,n),t=h(t,n),new _(e,t,n,r)}function _(e,t,n,r){function o(e){v.emit(\"change\",{direction:\"pull\",change:e})}function i(e){v.emit(\"change\",{direction:\"push\",change:e})}function s(e){v.emit(\"denied\",{direction:\"push\",doc:e})}function a(e){v.emit(\"denied\",{direction:\"pull\",doc:e})}function c(){v.pushPaused=!0,v.pullPaused&&v.emit(\"paused\")}function u(){v.pullPaused=!0,v.pushPaused&&v.emit(\"paused\")}function f(){v.pushPaused=!1,v.pullPaused&&v.emit(\"active\",{direction:\"push\"})}function l(){v.pullPaused=!1,v.pushPaused&&v.emit(\"active\",{direction:\"pull\"})}function d(e){return function(t,n){var r=\"change\"===t&&(n===o||n===i),d=\"denied\"===t&&(n===a||n===s),h=\"paused\"===t&&(n===u||n===c),p=\"active\"===t&&(n===l||n===f);(r||d||h||p)&&(t in m||(m[t]={}),m[t][e]=!0,2===Object.keys(m[t]).length&&v.removeAllListeners(t))}}function h(e,t,n){-1==e.listeners(t).indexOf(n)&&e.on(t,n)}var v=this;this.canceled=!1;var _=n.push?y.assign({},n,n.push):n,g=n.pull?y.assign({},n,n.pull):n;this.push=p(e,t,_),this.pull=p(t,e,g),this.pushPaused=!0,this.pullPaused=!0;var m={};n.live&&(this.push.on(\"complete\",v.pull.cancel.bind(v.pull)),this.pull.on(\"complete\",v.push.cancel.bind(v.push))),this.on(\"newListener\",function(e){\"change\"===e?(h(v.pull,\"change\",o),h(v.push,\"change\",i)):\"denied\"===e?(h(v.pull,\"denied\",a),h(v.push,\"denied\",s)):\"active\"===e?(h(v.pull,\"active\",l),h(v.push,\"active\",f)):\"paused\"===e&&(h(v.pull,\"paused\",u),h(v.push,\"paused\",c))}),this.on(\"removeListener\",function(e){\"change\"===e?(v.pull.removeListener(\"change\",o),v.push.removeListener(\"change\",i)):\"denied\"===e?(v.pull.removeListener(\"denied\",a),v.push.removeListener(\"denied\",s)):\"active\"===e?(v.pull.removeListener(\"active\",l),v.push.removeListener(\"active\",f)):\"paused\"===e&&(v.pull.removeListener(\"paused\",u),v.push.removeListener(\"paused\",c))}),this.pull.on(\"removeListener\",d(\"pull\")),this.push.on(\"removeListener\",d(\"push\"));var b=Promise.all([this.push,this.pull]).then(function(e){var t={push:e[0],pull:e[1]};return v.emit(\"complete\",t),r&&r(null,t),v.removeAllListeners(),t},function(e){if(v.cancel(),r?r(e):v.emit(\"error\",e),v.removeAllListeners(),r)throw e});this.then=function(e,t){return b.then(e,t)},this.catch=function(e){return b.catch(e)}}function g(e){e.replicate=p,e.sync=v,Object.defineProperty(e.prototype,\"replicate\",{get:function(){var e=this;return void 0===this.replicateMethods&&(this.replicateMethods={from:function(t,n,r){return e.constructor.replicate(t,e,n,r)},to:function(t,n,r){return e.constructor.replicate(e,t,n,r)}}),this.replicateMethods}}),e.prototype.sync=function(e,t,n){return this.constructor.sync(this,e,t,n)}}var y=e(36),m=r(e(20)),b=r(e(26)),w=e(24),k=e(10),E=r(e(12)),S=0;E(d,k.EventEmitter),d.prototype.cancel=function(){this.cancelled=!0,this.state=\"cancelled\",this.emit(\"cancel\")},d.prototype.ready=function(e,t){function n(){o.cancel()}function r(){e.removeListener(\"destroyed\",n),t.removeListener(\"destroyed\",n)}var o=this;o._readyCalled||(o._readyCalled=!0,e.once(\"destroyed\",n),t.once(\"destroyed\",n),o.once(\"complete\",r))},E(_,k.EventEmitter),_.prototype.cancel=function(){this.canceled||(this.canceled=!0,this.push.cancel(),this.pull.cancel())},t.exports=g},{10:10,12:12,20:20,24:24,26:26,36:36}],35:[function(e,t,n){\"use strict\";function r(e,t){for(var n=e,r=0,o=t.length;r<o;r++){if(!(n=n[t[r]]))break}return n}function o(e,t,n){for(var r=0,o=t.length;r<o-1;r++){e=e[t[r]]={}}e[t[o-1]]=n}function i(e,t){return e<t?-1:e>t?1:0}function s(e){for(var t=[],n=\"\",r=0,o=e.length;r<o;r++){var i=e[r];\".\"===i?r>0&&\"\\\\\"===e[r-1]?n=n.substring(0,n.length-1)+\".\":(t.push(n),n=\"\"):n+=i}return t.push(n),t}function a(e){return R.indexOf(e)>-1}function c(e){return Object.keys(e)[0]}function u(e){return e[c(e)]}function f(e){var t={};return e.forEach(function(e){Object.keys(e).forEach(function(n){var r=e[n];if(\"object\"!=typeof r&&(r={$eq:r}),a(n))r instanceof Array?t[n]=r.map(function(e){return f([e])}):t[n]=f([r]);else{var o=t[n]=t[n]||{};Object.keys(r).forEach(function(e){var t=r[e];return\"$gt\"===e||\"$gte\"===e?l(e,t,o):\"$lt\"===e||\"$lte\"===e?d(e,t,o):\"$ne\"===e?h(t,o):\"$eq\"===e?p(t,o):void(o[e]=t)})}})}),t}function l(e,t,n){void 0===n.$eq&&(void 0!==n.$gte?\"$gte\"===e?t>n.$gte&&(n.$gte=t):t>=n.$gte&&(delete n.$gte,n.$gt=t):void 0!==n.$gt?\"$gte\"===e?t>n.$gt&&(delete n.$gt,n.$gte=t):t>n.$gt&&(n.$gt=t):n[e]=t)}function d(e,t,n){void 0===n.$eq&&(void 0!==n.$lte?\"$lte\"===e?t<n.$lte&&(n.$lte=t):t<=n.$lte&&(delete n.$lte,n.$lt=t):void 0!==n.$lt?\"$lte\"===e?t<n.$lt&&(delete n.$lt,n.$lte=t):t<n.$lt&&(n.$lt=t):n[e]=t)}function h(e,t){\"$ne\"in t?t.$ne.push(e):t.$ne=[e]}function p(e,t){delete t.$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,t.$eq=e}function v(e){var t=x.clone(e),n=!1;\"$and\"in t&&(t=f(t.$and),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],o=e[r];\"object\"==typeof o&&null!==o||(e[r]={$eq:o})}})}),\"$not\"in t&&(t.$not=f([t.$not]));for(var r=Object.keys(t),o=0;o<r.length;o++){var i=r[o],s=t[i];\"object\"!=typeof s||null===s?s={$eq:s}:\"$ne\"in s&&!n&&(s.$ne=[s.$ne]),t[i]=s}return t}function _(e){function t(t){return e.map(function(e){var n=c(e),o=s(n);return r(t,o)})}return function(e,n){var r=t(e.doc),o=t(n.doc),s=C.collate(r,o);return 0!==s?s:i(e.doc._id,n.doc._id)}}function g(e,t,n){if(e=e.filter(function(e){return y(e.doc,t.selector,n)}),t.sort){var r=_(t.sort);e=e.sort(r),\"string\"!=typeof t.sort[0]&&\"desc\"===u(t.sort[0])&&(e=e.reverse())}if(\"limit\"in t||\"skip\"in t){var o=t.skip||0,i=(\"limit\"in t?t.limit:e.length)+o;e=e.slice(o,i)}return e}function y(e,t,n){return n.every(function(n){var o=t[n],i=s(n),c=r(e,i);return a(n)?b(n,o,e):m(o,e,i,c)})}function m(e,t,n,r){return!e||Object.keys(e).every(function(o){var i=e[o];return w(o,t,i,n,r)})}function b(e,t,n){return\"$or\"===e?t.some(function(e){return y(n,e,Object.keys(e))}):\"$not\"===e?!y(n,t,Object.keys(t)):!t.find(function(e){return y(n,e,Object.keys(e))})}function w(e,t,n,r,o){if(!T[e])throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type, $allMatch or $all');return T[e](t,n,r,o)}function k(e){return void 0!==e&&null!==e}function E(e){return void 0!==e}function S(e,t){var n=t[0],r=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(r,10)!==r)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===r}function O(e,t){return t.some(function(t){return e instanceof Array?e.indexOf(t)>-1:e===t})}function A(e,t){return t.every(function(t){return e.indexOf(t)>-1})}function I(e,t){return e.length===t}function j(e,t){return new RegExp(t).test(e)}function D(e,t){switch(t){case\"null\":return null===e;case\"boolean\":return\"boolean\"==typeof e;case\"number\":return\"number\"==typeof e;case\"string\":return\"string\"==typeof e;case\"array\":return e instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(e)}throw new Error(t+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}function q(e,t){if(\"object\"!=typeof t)throw new Error(\"Selector error: expected a JSON object\");t=v(t);var n={doc:e},r=g([n],{selector:t},Object.keys(t));return r&&1===r.length}Object.defineProperty(n,\"__esModule\",{value:!0});var x=e(36),C=e(21),R=[\"$or\",\"$nor\",\"$not\"],T={$elemMatch:function(e,t,n,r){return!!Array.isArray(r)&&(0!==r.length&&(\"object\"==typeof r[0]?r.some(function(e){return y(e,t,Object.keys(t))}):r.some(function(r){return m(t,e,n,r)})))},$allMatch:function(e,t,n,r){return!!Array.isArray(r)&&(0!==r.length&&(\"object\"==typeof r[0]?r.every(function(e){return y(e,t,Object.keys(t))}):r.every(function(r){return m(t,e,n,r)})))},$eq:function(e,t,n,r){return E(r)&&0===C.collate(r,t)},$gte:function(e,t,n,r){return E(r)&&C.collate(r,t)>=0},$gt:function(e,t,n,r){return E(r)&&C.collate(r,t)>0},$lte:function(e,t,n,r){return E(r)&&C.collate(r,t)<=0},$lt:function(e,t,n,r){return E(r)&&C.collate(r,t)<0},$exists:function(e,t,n,r){return t?E(r):!E(r)},$mod:function(e,t,n,r){return k(r)&&S(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==C.collate(r,e)})},$in:function(e,t,n,r){return k(r)&&O(r,t)},$nin:function(e,t,n,r){return k(r)&&!O(r,t)},$size:function(e,t,n,r){return k(r)&&I(r,t)},$all:function(e,t,n,r){return Array.isArray(r)&&A(r,t)},$regex:function(e,t,n,r){return k(r)&&j(r,t)},$type:function(e,t,n,r){return D(r,t)}};n.massageSelector=v,n.matchesSelector=q,n.filterInMemoryFields=g,n.createFieldSorter=_,n.rowFilter=y,n.isCombinationalField=a,n.getKey=c,n.getValue=u,n.getFieldFromDoc=r,n.setFieldInDoc=o,n.compare=i,n.parseField=s},{21:21,36:36}],36:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return\"undefined\"!=typeof ArrayBuffer&&e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function i(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function s(e){if(e instanceof ArrayBuffer)return i(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function a(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&Q.call(n)==W}function c(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=c(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return s(e);if(!a(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=c(e[n]);void 0!==i&&(t[n]=i)}return t}function u(e){var t=!1;return M(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return M(function(t){t=c(t);var n=this,r=\"function\"==typeof t[t.length-1]&&t.pop(),o=new Promise(function(r,o){var i;try{var s=u(function(e,t){e?o(e):r(t)});t.push(s),i=e.apply(n,t),i&&\"function\"==typeof i.then&&r(i)}catch(e){o(e)}});return r&&o.then(function(e){r(null,e)},r),o})}function l(e,t,n){if(e.constructor.listeners(\"debug\").length){for(var r=[\"api\",e.name,t],o=0;o<n.length-1;o++)r.push(n[o]);e.constructor.emit(\"debug\",r);var i=n[n.length-1];n[n.length-1]=function(n,r){var o=[\"api\",e.name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),e.constructor.emit(\"debug\",o),i(n,r)}}}function d(e,t){return f(M(function(n){if(this._closed)return Promise.reject(new Error(\"database is closed\"));if(this._destroyed)return Promise.reject(new Error(\"database is destroyed\"));var r=this;return l(r,e,n),this.taskqueue.isReady?t.apply(this,n):new Promise(function(t,o){r.taskqueue.addTask(function(i){i?o(i):t(r[e].apply(r,n))})})}))}function h(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}function p(e){return e}function v(e){return[{ok:e}]}function _(e,t,n){function r(){var e=[];d.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function i(e,t,n){d[e]={id:t,docs:n},o()}function s(){if(!(g>=_.length)){var e=Math.min(g+H,_.length),t=_.slice(g,e);a(t,g),g+=t.length}}function a(n,r){n.forEach(function(n,o){var a=r+o,c=u.get(n),f=h(c[0],[\"atts_since\",\"attachments\"]);f.open_revs=c.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(p);var l=p;0===f.open_revs.length&&(delete f.open_revs,l=v),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),i(a,n,r),s()})})}var c=t.docs,u=new $.Map;c.forEach(function(e){\nu.has(e.id)?u.get(e.id).push(e):u.set(e.id,[e])});var f=u.size,l=0,d=new Array(f),_=[];u.forEach(function(e,t){_.push(t)});var g=0;s()}function g(){return N}function y(e){g()&&addEventListener(\"storage\",function(t){e.emit(t.key)})}function m(){U.EventEmitter.call(this),this._listeners={},y(this)}function b(e){if(\"undefined\"!=typeof console&&\"function\"==typeof console[e]){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function w(e,t){return e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||t<=e?t=(e||1)<<1:t+=1,t>6e5&&(e=3e5,t=6e5),~~((t-e)*Math.random()+e)}function k(e){var t=0;return e||(t=2e3),w(e,t)}function E(e,t){b(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function S(e,t,n){try{return!e(t,n)}catch(e){var r=\"Filter function threw: \"+e.toString();return J.createError(J.BAD_REQUEST,r)}}function O(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&S(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var i in r.doc._attachments)r.doc._attachments.hasOwnProperty(i)&&(r.doc._attachments[i].stub=!0)}else delete r.doc;return!0}}function A(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t}function I(){}function j(e){var t;if(e?\"string\"!=typeof e?t=J.createError(J.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=J.createError(J.RESERVED_ID)):t=J.createError(J.MISSING_ID),t)throw t}function D(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(b(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())}function q(e,t){return\"listenerCount\"in e?e.listenerCount(t):U.EventEmitter.listenerCount(e,t)}function x(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function C(e){var t=x(e);return t?t.join(\"/\"):null}function R(e){for(var t=ie.exec(e),n={},r=14;r--;){var o=ne[r],i=t[r]||\"\",s=-1!==[\"user\",\"password\"].indexOf(o);n[o]=s?decodeURIComponent(i):i}return n[re]={},n[ne[12]].replace(oe,function(e,t,r){t&&(n[re][t]=r)}),n}function T(e,t){var n=[],r=[];for(var o in t)t.hasOwnProperty(o)&&(n.push(o),r.push(t[o]));return n.push(e),Function.apply(null,n).apply(null,r)}function L(e,t,n){return new Promise(function(r,o){e.get(t,function(i,s){if(i){if(404!==i.status)return o(i);s={}}var a=s._rev,c=n(s);if(!c)return r({updated:!1,rev:a});c._id=t,c._rev=a,r(B(e,c,n))})})}function B(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return L(e,t._id,n)})}function P(e,t){var n=z.clone(e);return t?(delete n._rev_tree,V.stringMd5(JSON.stringify(n))):G.v4().replace(/-/g,\"\").toLowerCase()}Object.defineProperty(n,\"__esModule\",{value:!0});var N,M=r(e(7)),$=e(22),F=r(e(11)),U=e(10),K=r(e(12)),J=e(24),G=r(e(39)),V=e(30),z=e(36),Q=Function.prototype.toString,W=Q.call(Object),H=6;try{localStorage.setItem(\"_pouch_check_localstorage\",1),N=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){N=!1}K(m,U.EventEmitter),m.prototype.addListener=function(e,t,n,r){function o(){function e(){s=!1}if(i._listeners[t]){if(s)return void(s=\"waiting\");s=!0;var a=h(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\",\"return_docs\"]);n.changes(a).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===s&&F(o),s=!1}).on(\"error\",e)}}if(!this._listeners[t]){var i=this,s=!1;this._listeners[t]=o,this.on(e,o)}},m.prototype.removeListener=function(e,t){t in this._listeners&&(U.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},m.prototype.notifyLocalWindows=function(e){g()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},m.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var Y;Y=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var o in r)Object.prototype.hasOwnProperty.call(r,o)&&(t[o]=r[o])}return t};var Z,X=Y,ee=I.name;Z=ee?function(e){return e.name}:function(e){var t=e.toString().match(/^\\s*function\\s*(?:(\\S+)\\s*)?\\(/);return t&&t[1]?t[1]:\"\"};var te=Z,ne=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],re=\"queryKey\",oe=/(?:^|&)([^&=]*)=?([^&]*)/g,ie=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,se=G.v4;n.adapterFun=d,n.assign=X,n.bulkGetShim=_,n.changesHandler=m,n.clone=c,n.defaultBackOff=k,n.explainError=E,n.filterChange=O,n.flatten=A,n.functionName=te,n.guardedConsole=b,n.hasLocalStorage=g,n.invalidIdError=j,n.isRemote=D,n.listenerCount=q,n.nextTick=F,n.normalizeDdocFunctionName=C,n.once=u,n.parseDdocFunctionName=x,n.parseUri=R,n.pick=h,n.rev=P,n.scopeEval=T,n.toPromise=f,n.upsert=L,n.uuid=se},{10:10,11:11,12:12,22:22,24:24,30:30,36:36,39:39,7:7}],37:[function(e,t,n){function r(){throw new Error(\"setTimeout has not been defined\")}function o(){throw new Error(\"clearTimeout has not been defined\")}function i(e){if(l===setTimeout)return setTimeout(e,0);if((l===r||!l)&&setTimeout)return l=setTimeout,setTimeout(e,0);try{return l(e,0)}catch(t){try{return l.call(null,e,0)}catch(t){return l.call(this,e,0)}}}function s(e){if(d===clearTimeout)return clearTimeout(e);if((d===o||!d)&&clearTimeout)return d=clearTimeout,clearTimeout(e);try{return d(e)}catch(t){try{return d.call(null,e)}catch(t){return d.call(this,e)}}}function a(){_&&p&&(_=!1,p.length?v=p.concat(v):g=-1,v.length&&c())}function c(){if(!_){var e=i(a);_=!0;for(var t=v.length;t;){for(p=v,v=[];++g<t;)p&&p[g].run();g=-1,t=v.length}p=null,_=!1,s(e)}}function u(e,t){this.fun=e,this.array=t}function f(){}var l,d,h=t.exports={};!function(){try{l=\"function\"==typeof setTimeout?setTimeout:r}catch(e){l=r}try{d=\"function\"==typeof clearTimeout?clearTimeout:o}catch(e){d=o}}();var p,v=[],_=!1,g=-1;h.nextTick=function(e){var t=new Array(arguments.length-1);if(arguments.length>1)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];v.push(new u(e,t)),1!==v.length||_||i(c)},u.prototype.run=function(){this.fun.apply(null,this.array)},h.title=\"browser\",h.browser=!0,h.env={},h.argv=[],h.version=\"\",h.versions={},h.on=f,h.addListener=f,h.once=f,h.off=f,h.removeListener=f,h.removeAllListeners=f,h.emit=f,h.prependListener=f,h.prependOnceListener=f,h.listeners=function(e){return[]},h.binding=function(e){throw new Error(\"process.binding is not supported\")},h.cwd=function(){return\"/\"},h.chdir=function(e){throw new Error(\"process.chdir is not supported\")},h.umask=function(){return 0}},{}],38:[function(e,t,n){!function(e){if(\"object\"==typeof n)t.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var r;try{r=window}catch(e){r=self}r.SparkMD5=e()}}(function(e){\"use strict\";function t(e,t){var n=e[0],r=e[1],o=e[2],i=e[3];n+=(r&o|~r&i)+t[0]-680876936|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[1]-389564586|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[2]+606105819|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[3]-1044525330|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[4]-176418897|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[5]+1200080426|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[6]-1473231341|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[7]-45705983|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[8]+1770035416|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[9]-1958414417|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[10]-42063|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[11]-1990404162|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[12]+1804603682|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[13]-40341101|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[14]-1502002290|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[15]+1236535329|0,r=(r<<22|r>>>10)+o|0,n+=(r&i|o&~i)+t[1]-165796510|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[6]-1069501632|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[11]+643717713|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[0]-373897302|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[5]-701558691|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[10]+38016083|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[15]-660478335|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[4]-405537848|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[9]+568446438|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[14]-1019803690|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[3]-187363961|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[8]+1163531501|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[13]-1444681467|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[2]-51403784|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[7]+1735328473|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[12]-1926607734|0,r=(r<<20|r>>>12)+o|0,n+=(r^o^i)+t[5]-378558|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[8]-2022574463|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[11]+1839030562|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[14]-35309556|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[1]-1530992060|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[4]+1272893353|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[7]-155497632|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[10]-1094730640|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[13]+681279174|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[0]-358537222|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[3]-722521979|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[6]+76029189|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[9]-640364487|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[12]-421815835|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[15]+530742520|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[2]-995338651|0,r=(r<<23|r>>>9)+o|0,n+=(o^(r|~i))+t[0]-198630844|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[7]+1126891415|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[14]-1416354905|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[5]-57434055|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[12]+1700485571|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[3]-1894986606|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[10]-1051523|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[1]-2054922799|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[8]+1873313359|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[15]-30611744|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[6]-1560198380|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[13]+1309151649|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[4]-145523070|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[11]-1120210379|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[2]+718787259|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[9]-343485551|0,r=(r<<21|r>>>11)+o|0,e[0]=n+e[0]|0,e[1]=r+e[1]|0,e[2]=o+e[2]|0,e[3]=i+e[3]|0}function n(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e.charCodeAt(t)+(e.charCodeAt(t+1)<<8)+(e.charCodeAt(t+2)<<16)+(e.charCodeAt(t+3)<<24);return n}function r(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e[t]+(e[t+1]<<8)+(e[t+2]<<16)+(e[t+3]<<24);return n}function o(e){var r,o,i,s,a,c,u=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(r=64;r<=u;r+=64)t(f,n(e.substring(r-64,r)));for(e=e.substring(r-64),o=e.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],r=0;r<o;r+=1)i[r>>2]|=e.charCodeAt(r)<<(r%4<<3);if(i[r>>2]|=128<<(r%4<<3),r>55)for(t(f,i),r=0;r<16;r+=1)i[r]=0;return s=8*u,s=s.toString(16).match(/(.*?)(.{0,8})$/),a=parseInt(s[2],16),c=parseInt(s[1],16)||0,i[14]=a,i[15]=c,t(f,i),f}function i(e){var n,o,i,s,a,c,u=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(n=64;n<=u;n+=64)t(f,r(e.subarray(n-64,n)));for(e=n-64<u?e.subarray(n-64):new Uint8Array(0),o=e.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],n=0;n<o;n+=1)i[n>>2]|=e[n]<<(n%4<<3);if(i[n>>2]|=128<<(n%4<<3),n>55)for(t(f,i),n=0;n<16;n+=1)i[n]=0;return s=8*u,s=s.toString(16).match(/(.*?)(.{0,8})$/),a=parseInt(s[2],16),c=parseInt(s[1],16)||0,i[14]=a,i[15]=c,t(f,i),f}function s(e){var t,n=\"\";for(t=0;t<4;t+=1)n+=p[e>>8*t+4&15]+p[e>>8*t&15];return n}function a(e){var t;for(t=0;t<e.length;t+=1)e[t]=s(e[t]);return e.join(\"\")}function c(e){return/[\\u0080-\\uFFFF]/.test(e)&&(e=unescape(encodeURIComponent(e))),e}function u(e,t){var n,r=e.length,o=new ArrayBuffer(r),i=new Uint8Array(o);for(n=0;n<r;n+=1)i[n]=e.charCodeAt(n);return t?i:o}function f(e){return String.fromCharCode.apply(null,new Uint8Array(e))}function l(e,t,n){var r=new Uint8Array(e.byteLength+t.byteLength);return r.set(new Uint8Array(e)),r.set(new Uint8Array(t),e.byteLength),n?r:r.buffer}function d(e){var t,n=[],r=e.length;for(t=0;t<r-1;t+=2)n.push(parseInt(e.substr(t,2),16));return String.fromCharCode.apply(String,n)}function h(){this.reset()}var p=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];return\"5d41402abc4b2a76b9719d911017c592\"!==a(o(\"hello\"))&&function(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n},\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||function(){function t(e,t){return e=0|e||0,e<0?Math.max(e+t,0):Math.min(e,t)}ArrayBuffer.prototype.slice=function(n,r){var o,i,s,a,c=this.byteLength,u=t(n,c),f=c;return r!==e&&(f=t(r,c)),u>f?new ArrayBuffer(0):(o=f-u,i=new ArrayBuffer(o),s=new Uint8Array(i),a=new Uint8Array(this,u,o),s.set(a),i)}}(),h.prototype.append=function(e){return this.appendBinary(c(e)),this},h.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;var r,o=this._buff.length;for(r=64;r<=o;r+=64)t(this._hash,n(this._buff.substring(r-64,r)));return this._buff=this._buff.substring(r-64),this},h.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r.charCodeAt(t)<<(t%4<<3);return this._finish(i,o),n=a(this._hash),e&&(n=d(n)),this.reset(),n},h.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},h.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},h.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},h.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},h.prototype._finish=function(e,n){var r,o,i,s=n;if(e[s>>2]|=128<<(s%4<<3),s>55)for(t(this._hash,e),s=0;s<16;s+=1)e[s]=0;r=8*this._length,r=r.toString(16).match(/(.*?)(.{0,8})$/),o=parseInt(r[2],16),i=parseInt(r[1],16)||0,e[14]=o,e[15]=i,t(this._hash,e)},h.hash=function(e,t){return h.hashBinary(c(e),t)},h.hashBinary=function(e,t){var n=o(e),r=a(n);return t?d(r):r},h.ArrayBuffer=function(){this.reset()},h.ArrayBuffer.prototype.append=function(e){var n,o=l(this._buff.buffer,e,!0),i=o.length;for(this._length+=e.byteLength,n=64;n<=i;n+=64)t(this._hash,r(o.subarray(n-64,n)));return this._buff=n-64<i?new Uint8Array(o.buffer.slice(n-64)):new Uint8Array(0),this},h.ArrayBuffer.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r[t]<<(t%4<<3);return this._finish(i,o),n=a(this._hash),e&&(n=d(n)),this.reset(),n},h.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},h.ArrayBuffer.prototype.getState=function(){var e=h.prototype.getState.call(this);return e.buff=f(e.buff),e},h.ArrayBuffer.prototype.setState=function(e){return e.buff=u(e.buff,!0),h.prototype.setState.call(this,e)},h.ArrayBuffer.prototype.destroy=h.prototype.destroy,h.ArrayBuffer.prototype._finish=h.prototype._finish,h.ArrayBuffer.hash=function(e,t){var n=i(new Uint8Array(e)),r=a(n);return t?d(r):r},h})},{}],39:[function(e,t,n){var r=e(42),o=e(43),i=o;i.v1=r,i.v4=o,t.exports=i},{42:42,43:43}],40:[function(e,t,n){function r(e,t){var n=t||0,r=o;return r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]}for(var o=[],i=0;i<256;++i)o[i]=(i+256).toString(16).substr(1);t.exports=r},{}],41:[function(e,t,n){var r=\"undefined\"!=typeof crypto&&crypto.getRandomValues.bind(crypto)||\"undefined\"!=typeof msCrypto&&msCrypto.getRandomValues.bind(msCrypto);if(r){var o=new Uint8Array(16);t.exports=function(){return r(o),o}}else{var i=new Array(16);t.exports=function(){for(var e,t=0;t<16;t++)0==(3&t)&&(e=4294967296*Math.random()),i[t]=e>>>((3&t)<<3)&255;return i}}},{}],42:[function(e,t,n){function r(e,t,n){var r=t&&n||0,f=t||[];e=e||{};var l=e.node||o,d=void 0!==e.clockseq?e.clockseq:i;if(null==l||null==d){var h=s();null==l&&(l=o=[1|h[0],h[1],h[2],h[3],h[4],h[5]]),null==d&&(d=i=16383&(h[6]<<8|h[7]))}var p=void 0!==e.msecs?e.msecs:(new Date).getTime(),v=void 0!==e.nsecs?e.nsecs:u+1,_=p-c+(v-u)/1e4;if(_<0&&void 0===e.clockseq&&(d=d+1&16383),(_<0||p>c)&&void 0===e.nsecs&&(v=0),v>=1e4)throw new Error(\"uuid.v1(): Can't create more than 10M uuids/sec\");c=p,u=v,i=d,p+=122192928e5;var g=(1e4*(268435455&p)+v)%4294967296;f[r++]=g>>>24&255,f[r++]=g>>>16&255,f[r++]=g>>>8&255,f[r++]=255&g;var y=p/4294967296*1e4&268435455;f[r++]=y>>>8&255,f[r++]=255&y,f[r++]=y>>>24&15|16,f[r++]=y>>>16&255,f[r++]=d>>>8|128,f[r++]=255&d;for(var m=0;m<6;++m)f[r+m]=l[m];return t||a(f)}var o,i,s=e(41),a=e(40),c=0,u=0;t.exports=r},{40:40,41:41}],43:[function(e,t,n){function r(e,t,n){var r=t&&n||0;\"string\"==typeof e&&(t=\"binary\"===e?new Array(16):null,e=null),e=e||{};var s=e.random||(e.rng||o)();if(s[6]=15&s[6]|64,s[8]=63&s[8]|128,t)for(var a=0;a<16;++a)t[r+a]=s[a];return t||i(s)}var o=e(41),i=e(40);t.exports=r},{40:40,41:41}],44:[function(e,t,n){\"use strict\";function r(e,t,n){var r=n[n.length-1];e===r.element&&(n.pop(),r=n[n.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(e);else if(i===t.length-2){var s=t.pop();o[s]=e}else t.push(e)}n.stringify=function(e){var t=[];t.push({obj:e});for(var n,r,o,i,s,a,c,u,f,l,d,h=\"\";n=t.pop();)if(r=n.obj,o=n.prefix||\"\",i=n.val||\"\",h+=o,i)h+=i;else if(\"object\"!=typeof r)h+=void 0===r?null:JSON.stringify(r);else if(null===r)h+=\"null\";else if(Array.isArray(r)){for(t.push({val:\"]\"}),s=r.length-1;s>=0;s--)a=0===s?\"\":\",\",t.push({obj:r[s],prefix:a});t.push({val:\"[\"})}else{c=[];for(u in r)r.hasOwnProperty(u)&&c.push(u);for(t.push({val:\"}\"}),s=c.length-1;s>=0;s--)f=c[s],l=r[f],d=s>0?\",\":\"\",d+=JSON.stringify(f)+\":\",t.push({obj:l,prefix:d});t.push({val:\"{\"})}return h},n.parse=function(e){for(var t,n,o,i,s,a,c,u,f,l=[],d=[],h=0;;)if(\"}\"!==(t=e[h++])&&\"]\"!==t&&void 0!==t)switch(t){case\" \":case\"\\t\":case\"\\n\":case\":\":case\",\":break;case\"n\":h+=3,r(null,l,d);break;case\"t\":h+=3,r(!0,l,d);break;case\"f\":h+=4,r(!1,l,d);break;case\"0\":case\"1\":case\"2\":case\"3\":case\"4\":case\"5\":case\"6\":case\"7\":case\"8\":case\"9\":case\"-\":for(n=\"\",h--;;){if(o=e[h++],!/[\\d\\.\\-e\\+]/.test(o)){h--;break}n+=o}r(parseFloat(n),l,d);break;case'\"':for(i=\"\",s=void 0,a=0;;){if('\"'===(c=e[h++])&&(\"\\\\\"!==s||a%2!=1))break;i+=c,s=c,\"\\\\\"===s?a++:a=0}r(JSON.parse('\"'+i+'\"'),l,d);break;case\"[\":u={element:[],index:l.length},l.push(u.element),d.push(u);break;case\"{\":f={element:{},index:l.length},l.push(f.element),d.push(f);break;default:throw new Error(\"unexpectedly reached end of input: \"+t)}else{if(1===l.length)return l.pop();r(l.pop(),l,d)}}},{}]},{},[3]);";
},{}],11:[function(_dereq_,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = _dereq_(12);
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this,_dereq_(20))
},{"12":12,"20":20}],12:[function(_dereq_,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = _dereq_(16);

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  return debug;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"16":16}],13:[function(_dereq_,module,exports){
(function (global){
'use strict';
var Mutation = global.MutationObserver || global.WebKitMutationObserver;

var scheduleDrain;

{
  if (Mutation) {
    var called = 0;
    var observer = new Mutation(nextTick);
    var element = global.document.createTextNode('');
    observer.observe(element, {
      characterData: true
    });
    scheduleDrain = function () {
      element.data = (called = ++called % 2);
    };
  } else if (!global.setImmediate && typeof global.MessageChannel !== 'undefined') {
    var channel = new global.MessageChannel();
    channel.port1.onmessage = nextTick;
    scheduleDrain = function () {
      channel.port2.postMessage(0);
    };
  } else if ('document' in global && 'onreadystatechange' in global.document.createElement('script')) {
    scheduleDrain = function () {

      // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted
      // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.
      var scriptEl = global.document.createElement('script');
      scriptEl.onreadystatechange = function () {
        nextTick();

        scriptEl.onreadystatechange = null;
        scriptEl.parentNode.removeChild(scriptEl);
        scriptEl = null;
      };
      global.document.documentElement.appendChild(scriptEl);
    };
  } else {
    scheduleDrain = function () {
      setTimeout(nextTick, 0);
    };
  }
}

var draining;
var queue = [];
//named nextTick for less confusing stack traces
function nextTick() {
  draining = true;
  var i, oldQueue;
  var len = queue.length;
  while (len) {
    oldQueue = queue;
    queue = [];
    i = -1;
    while (++i < len) {
      oldQueue[i]();
    }
    len = queue.length;
  }
  draining = false;
}

module.exports = immediate;
function immediate(task) {
  if (queue.push(task) === 1 && !draining) {
    scheduleDrain();
  }
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],14:[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],15:[function(_dereq_,module,exports){
(function(factory) {
  if(typeof exports === 'object') {
    factory(exports);
  } else {
    factory(this);
  }
}).call(this, function(root) { 

  var slice   = Array.prototype.slice,
      each    = Array.prototype.forEach;

  var extend = function(obj) {
    if(typeof obj !== 'object') throw obj + ' is not an object' ;

    var sources = slice.call(arguments, 1); 

    each.call(sources, function(source) {
      if(source) {
        for(var prop in source) {
          if(typeof source[prop] === 'object' && obj[prop]) {
            extend.call(obj, obj[prop], source[prop]);
          } else {
            obj[prop] = source[prop];
          }
        } 
      }
    });

    return obj;
  }

  root.extend = extend;
});

},{}],16:[function(_dereq_,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options["long"] ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],17:[function(_dereq_,module,exports){
(function (global){
"use strict";

//Abstracts constructing a Blob object, so it also works in older
//browsers that don't support the native Blob constructor. (i.e.
//old QtWebKit versions, at least).
function createBlob(parts, properties) {
  parts = parts || [];
  properties = properties || {};
  try {
    return new Blob(parts, properties);
  } catch (e) {
    if (e.name !== "TypeError") {
      throw e;
    }
    var BlobBuilder = global.BlobBuilder ||
                      global.MSBlobBuilder ||
                      global.MozBlobBuilder ||
                      global.WebKitBlobBuilder;
    var builder = new BlobBuilder();
    for (var i = 0; i < parts.length; i += 1) {
      builder.append(parts[i]);
    }
    return builder.getBlob(properties.type);
  }
}

//Can't find original post, but this is close
//http://stackoverflow.com/questions/6965107/ (continues on next line)
//converting-between-strings-and-arraybuffers
function arrayBufferToBinaryString(buffer) {
  var binary = "";
  var bytes = new Uint8Array(buffer);
  var length = bytes.byteLength;
  for (var i = 0; i < length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

// This used to be called "fixBinary", which wasn't a very evocative name
// From http://stackoverflow.com/questions/14967647/ (continues on next line)
// encode-decode-image-with-base64-breaks-image (2013-04-21)
function binaryStringToArrayBuffer(bin) {
  var length = bin.length;
  var buf = new ArrayBuffer(length);
  var arr = new Uint8Array(buf);
  for (var i = 0; i < length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return buf;
}

// shim for browsers that don't support it
function readAsBinaryString(blob, callback) {
  var reader = new FileReader();
  var hasBinaryString = typeof reader.readAsBinaryString === 'function';
  reader.onloadend = function (e) {
    var result = e.target.result || '';
    if (hasBinaryString) {
      return callback(result);
    }
    callback(arrayBufferToBinaryString(result));
  };
  if (hasBinaryString) {
    reader.readAsBinaryString(blob);
  } else {
    reader.readAsArrayBuffer(blob);
  }
}

// simplified API. universal browser support is assumed
function readAsArrayBuffer(blob, callback) {
  var reader = new FileReader();
  reader.onloadend = function (e) {
    var result = e.target.result || new ArrayBuffer(0);
    callback(result);
  };
  reader.readAsArrayBuffer(blob);
}

module.exports = {
  createBlob: createBlob,
  readAsArrayBuffer: readAsArrayBuffer,
  readAsBinaryString: readAsBinaryString,
  binaryStringToArrayBuffer: binaryStringToArrayBuffer,
  arrayBufferToBinaryString: arrayBufferToBinaryString
};


}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],18:[function(_dereq_,module,exports){
'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var lie = _interopDefault(_dereq_(19));

/* istanbul ignore next */
var PouchPromise = typeof Promise === 'function' ? Promise : lie;

module.exports = PouchPromise;

},{"19":19}],19:[function(_dereq_,module,exports){
'use strict';
var immediate = _dereq_(13);

/* istanbul ignore next */
function INTERNAL() {}

var handlers = {};

var REJECTED = ['REJECTED'];
var FULFILLED = ['FULFILLED'];
var PENDING = ['PENDING'];

module.exports = Promise;

function Promise(resolver) {
  if (typeof resolver !== 'function') {
    throw new TypeError('resolver must be a function');
  }
  this.state = PENDING;
  this.queue = [];
  this.outcome = void 0;
  if (resolver !== INTERNAL) {
    safelyResolveThenable(this, resolver);
  }
}

Promise.prototype["catch"] = function (onRejected) {
  return this.then(null, onRejected);
};
Promise.prototype.then = function (onFulfilled, onRejected) {
  if (typeof onFulfilled !== 'function' && this.state === FULFILLED ||
    typeof onRejected !== 'function' && this.state === REJECTED) {
    return this;
  }
  var promise = new this.constructor(INTERNAL);
  if (this.state !== PENDING) {
    var resolver = this.state === FULFILLED ? onFulfilled : onRejected;
    unwrap(promise, resolver, this.outcome);
  } else {
    this.queue.push(new QueueItem(promise, onFulfilled, onRejected));
  }

  return promise;
};
function QueueItem(promise, onFulfilled, onRejected) {
  this.promise = promise;
  if (typeof onFulfilled === 'function') {
    this.onFulfilled = onFulfilled;
    this.callFulfilled = this.otherCallFulfilled;
  }
  if (typeof onRejected === 'function') {
    this.onRejected = onRejected;
    this.callRejected = this.otherCallRejected;
  }
}
QueueItem.prototype.callFulfilled = function (value) {
  handlers.resolve(this.promise, value);
};
QueueItem.prototype.otherCallFulfilled = function (value) {
  unwrap(this.promise, this.onFulfilled, value);
};
QueueItem.prototype.callRejected = function (value) {
  handlers.reject(this.promise, value);
};
QueueItem.prototype.otherCallRejected = function (value) {
  unwrap(this.promise, this.onRejected, value);
};

function unwrap(promise, func, value) {
  immediate(function () {
    var returnValue;
    try {
      returnValue = func(value);
    } catch (e) {
      return handlers.reject(promise, e);
    }
    if (returnValue === promise) {
      handlers.reject(promise, new TypeError('Cannot resolve promise with itself'));
    } else {
      handlers.resolve(promise, returnValue);
    }
  });
}

handlers.resolve = function (self, value) {
  var result = tryCatch(getThen, value);
  if (result.status === 'error') {
    return handlers.reject(self, result.value);
  }
  var thenable = result.value;

  if (thenable) {
    safelyResolveThenable(self, thenable);
  } else {
    self.state = FULFILLED;
    self.outcome = value;
    var i = -1;
    var len = self.queue.length;
    while (++i < len) {
      self.queue[i].callFulfilled(value);
    }
  }
  return self;
};
handlers.reject = function (self, error) {
  self.state = REJECTED;
  self.outcome = error;
  var i = -1;
  var len = self.queue.length;
  while (++i < len) {
    self.queue[i].callRejected(error);
  }
  return self;
};

function getThen(obj) {
  // Make sure we only access the accessor once as required by the spec
  var then = obj && obj.then;
  if (obj && (typeof obj === 'object' || typeof obj === 'function') && typeof then === 'function') {
    return function appyThen() {
      then.apply(obj, arguments);
    };
  }
}

function safelyResolveThenable(self, thenable) {
  // Either fulfill, reject or reject with error
  var called = false;
  function onError(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.reject(self, value);
  }

  function onSuccess(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.resolve(self, value);
  }

  function tryToUnwrap() {
    thenable(onSuccess, onError);
  }

  var result = tryCatch(tryToUnwrap);
  if (result.status === 'error') {
    onError(result.value);
  }
}

function tryCatch(func, value) {
  var out = {};
  try {
    out.value = func(value);
    out.status = 'success';
  } catch (e) {
    out.status = 'error';
    out.value = e;
  }
  return out;
}

Promise.resolve = resolve;
function resolve(value) {
  if (value instanceof this) {
    return value;
  }
  return handlers.resolve(new this(INTERNAL), value);
}

Promise.reject = reject;
function reject(reason) {
  var promise = new this(INTERNAL);
  return handlers.reject(promise, reason);
}

Promise.all = all;
function all(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var values = new Array(len);
  var resolved = 0;
  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    allResolver(iterable[i], i);
  }
  return promise;
  function allResolver(value, i) {
    self.resolve(value).then(resolveFromAll, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
    function resolveFromAll(outValue) {
      values[i] = outValue;
      if (++resolved === len && !called) {
        called = true;
        handlers.resolve(promise, values);
      }
    }
  }
}

Promise.race = race;
function race(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    resolver(iterable[i]);
  }
  return promise;
  function resolver(value) {
    self.resolve(value).then(function (response) {
      if (!called) {
        called = true;
        handlers.resolve(promise, response);
      }
    }, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
  }
}

},{"13":13}],20:[function(_dereq_,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],21:[function(_dereq_,module,exports){
'use strict';

module.exports = _dereq_(3);
},{"3":3}]},{},[21])(21)
});