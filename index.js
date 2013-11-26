var assert       = require('assert');
var inherits     = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var extend       = require('util')._extend;
var Sublevel     = require('level-sublevel');
var stringify    = require('json-stringify-safe');
var backoff      = require('backoff');
var xtend        = require('xtend');
var peek         = require('./peek');
var timestamp    = require('./timestamp');

var defaultOptions = {
  maxConcurrency: Infinity,
  maxRetries:     10,
  backoff: {
    randomisationFactor: 0,
    initialDelay: 10,
    maxDelay: 300
  }
};

exports = module.exports = Jobs;

function Jobs(db, worker, options) {
  assert.equal(typeof db, 'object', 'need db');
  assert.equal(typeof worker, 'function', 'need worker function');

  return new Queue(db, worker, options);
}

function Queue(db, worker, options) {
  EventEmitter.call(this);

  if (typeof options == 'number') options = { maxConcurrency: options };
  options = xtend(defaultOptions, options);

  this._options        = options;
  this._db             = db = Sublevel(db);
  this._work           = db.sublevel('work');
  this._pending        = db.sublevel('pending');
  this._worker         = worker;
  this._concurrency    = 0;

  // flags
  this._starting   = true;
  this._flushing   = false;
  this._peeking    = false;
  this._needsFlush = false;
  this._needsDrain = true;

  start(this);
}

inherits(Queue, EventEmitter);

var Q = Queue.prototype;


/// push

Q.push = function push(payload, cb) {
  var q = this;
  q._needsDrain = true;
  this._work.put(timestamp(), stringify(payload), put);

  function put(err) {
    if (err) {
      if (cb) cb(err);
      else q.emit('error', err);
    } else if (cb) cb();
    maybeFlush(q);
  }
};

Q.batchPush = function batchPush(payloads, cb) {
  var q = this
    , payloadKeys = Object.keys(payloads)
    , batch = payloadKeys.map(function (plk) {
        return { type: 'put', key: plk, value: stringify(payloads[plk]), prefix: q._work }
      });
  q._needsDrain = true;
  q._db.batch(batch, put);

  function put(err) {
    if (err) {
      if (cb) cb(err);
      else q.emit('error', err);
    } else if (cb) cb(null, payloadKeys);
    maybeFlush(q);
  }
};

/// accessor to db

Q.workDb = function () {
  return this._work;
};

Q.pendingDb = function () {
  return this._pending;
};

/// start

function start(q) {
  var ws = q._work.createWriteStream();
  q._pending.createReadStream().pipe(ws);
  ws.once('close', done);

  function done() {
    q._starting = false;
    maybeFlush(q);
  }
}


/// maybeFlush

function maybeFlush(q) {
  if (! q._starting && ! q._flushing) flush(q);
  else q._needsFlush = true;
}

/// flush

function flush(q) {
  if (q._concurrency < q._options.maxConcurrency && ! q._peeking) {
    q._peeking  = true;
    q._flushing = true;
    peek(q._work, poke);
  }

  function poke(err, key, work) {
    q._peeking = false;
    var done = false;

    if (key) {
      q._concurrency ++;
      q._db.batch([
        { type: 'del', key: key, prefix: q._work },
        { type: 'put', key: key, value: work, prefix: q._pending }
      ], transfered);
    } else {
      q._flushing = false;
      if (q._needsFlush) {
        q._needsFlush = false;
        maybeFlush(q);
      } else if (q._needsDrain) {
        q._needsDrain = false;
        q.emit('drain');
      }
    }

    function transfered(err) {
      if (err) {
        q._needsDrain = true;
        q._concurrency --;
        q.emit('error', err);
      } else {
        run(q, JSON.parse(work), ran);
      }
      flush(q);
    }

    function ran(err) {
      if (!err) {
        if (! done) {
          done = true;
          q._needsDrain = true;
          q._concurrency --;
          q._pending.del(key, deletedPending);
        }
      } else handleRunError(err);
    }

    function deletedPending(_err) {
      if (err) q.emit('error', _err);
      flush(q);
    }

    function handleRunError(err) {
      var errorBackoff = backoff.exponential(q._options.backoff);
      errorBackoff.failAfter(q._options.maxRetries);

      errorBackoff.on('ready', function() {
        run(q, JSON.parse(work), ranAgain);
      });

      errorBackoff.once('fail', function() {
        q.emit('error', new Error('max retries reached'));
      });

      function ranAgain(err) {
        if (err) errorBackoff.backoff();
        else ran();
      }

      errorBackoff.backoff();
    }

  }
}


/// run

function run(q, work, cb) {
  q._worker(work, cb);
}