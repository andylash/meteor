var assert = require("assert");
var path = require("path");
var fs = require("fs");
var _ = require("underscore");
var hasOwn = Object.prototype.hasOwnProperty;

// This class encapsulates a structured specification of files and
// directories that should be stripped from the node_modules directories
// of Meteor packages during `meteor build`, as requested by calling
// `Npm.discard` in package.js files.
function NpmDiscards() {
  assert.ok(this instanceof NpmDiscards);
  this.discards = {};
}

var NDp = NpmDiscards.prototype;

// Update the current specification of discarded files with additional
// patterns that should be discarded. See the comment in package-source.js
// about `Npm.discard` for an explanation of what should be passed for the
// `discards` parameter.
NDp.merge = function(discards) {
  merge(this.discards, discards);
};

function merge(into, from) {
  for (var packageName in from) {
    var fromValue = getValue(from, packageName);
    if (! fromValue) {
      continue;
    }

    var intoValue = getValue(into, packageName);
    if (! intoValue) {
      // Make a defensive copy of any arrays passed to `Npm.discard`.
      if (_.isArray(fromValue) && fromValue === from[packageName]) {
        fromValue = fromValue.slice(0);
      }

      // It's the first time we've seen any patterns for this package.
      into[packageName] = fromValue;

      continue;
    }

    if (_.isArray(intoValue) &&
        _.isArray(fromValue)) {
      // If intoValue and fromValue are both arrays of String/RegExp
      // patterns, append the contents of `fromValue` to `intoValue`.
      intoValue.push.apply(intoValue, fromValue);
      continue;
    }

    var intoObj = getPropAsObj(into, packageName);
    var fromObj = getPropAsObj(from, packageName);
    if (intoObj && fromObj) {
      // After converting both `intoValue` and `fromValue` to objects
      // using `getPropAsObj`, recursively merge them.
      into[packageName] = intoObj;
      merge(intoObj, fromObj);
    }
  }
}

function getValue(obj, name) {
  if (hasOwn.call(obj, name)) {
    var value = obj[name];
    // Allow `value` to be a String or RegExp, but convert it to a
    // singleton array for consistency with the recommended style.
    if (_.isString(value) ||
        _.isRegExp(value)) {
      return obj[name] = [value];
    }
    return value;
  }
}

function getPropAsObj(parent, property) {
  if (hasOwn.call(parent, property)) {
    var value = parent[property];
    if (_.isArray(value) || ! _.isObject(value)) {
      // The code in this function is probably the most subtle part of the
      // whole module. We know how to merge two arrays of patterns (append
      // one to the other) and two objects with package-name keys (copy
      // one object into the other, and recursively merge the values of
      // any keys that collide), but what if we need to merge an array
      // with an object, or vice-versa?
      //
      // This helper function coerces property values to objects if they
      // are not objects already, so that we only have to think about the
      // case of merging two objects. Specifically, if `value` is not
      // already an object, we wrap it in a new object `child` such that
      // `child[property] === value`, and then return `child`.
      //
      // For example, suppose the current value of `this.discards` is
      //
      //   { connect: ["huge.wmv"] }
      //
      // To review, this means "discard any files called 'huge.wmv' from
      // the 'connect' package." Now suppose we want to merge the
      // following additional patterns into `this.discards`:
      //
      //   { connect: { multiparty: ["test/"] } }
      //
      // This means the "test" directory of the "multiparty" dependency
      // should also be discarded. In order to merge the values of the two
      // "connect" properties, we need both values to be objects, so we
      // turn `["huge.wmv"]` into `{ connect: ["huge.wmv"] }`, which can
      // then be merged with `{ multiparty: ["test/"] }`, leading to this
      // final structure:
      //
      //   {
      //     connect: {
      //       connect: ["huge.wmv"],
      //       multiparty: ["test/"]
      //     }
      //   }
      //
      // This structure makes intuitive sense because the "connect"
      // package that the "connect" package depends upon is always simply
      // the "connect" package itself.
      var child = {};
      child[property] = value;
      return child;
    }
    return value;
  }
}

// Given an actual filesystem directory, build a mapping from absolute
// package directories to lists of patterns to be discarded.
NDp.buildDiscardChecker = function(rootDir) {
  return new NpmDiscardChecker(rootDir, this.buildDiscardMap(rootDir));
};

NDp.buildDiscardMap = function(rootDir) {
  var discardMap = Object.create(null);

  if (path.basename(rootDir) === "node_modules") {
    rootDir = path.dirname(rootDir);
  }

  function populateDiscardMap(discards, relDir) {
    Object.keys(discards).forEach(function(childPkgName) {
      var dir = path.join(rootDir, relDir);
      while (true) {
        var childPkgDir = path.join(dir, "node_modules", childPkgName);
        var files = readDir(childPkgDir);
        if (files) {
          // If we were able to read the contents of `childPkgDir`, then
          // it must be (1) an NPM package and (2) visible to the
          // `require` function of the parent package.
          var discardsForPackage = discards[childPkgName];
          var isArray = _.isArray(discardsForPackage);

          if (! isArray && _.isObject(discardsForPackage)) {
            populateDiscardMap(
              discardsForPackage,
              path.relative(rootDir, childPkgDir)
            );

          } else {
            if (! isArray) {
              discardsForPackage = [discardsForPackage];
            }

            var intoArray = hasOwn.call(discardMap, childPkgDir)
              ? discardMap[childPkgDir]
              : discardMap[childPkgDir] = [];

            intoArray.push.apply(intoArray, discardsForPackage);
          }

          break;
        }

        // If we didn't find a package with name `childPkgName` in a
        // "node_modules" subdirectory within the current directory `dir`,
        // then keep looking for other "node_modules" directories in
        // `parentDir` (and so on).
        var parentDir = path.dirname(dir);
        if (parentDir === dir) {
          break;
        }

        dir = parentDir;
      }
    });
  }

  populateDiscardMap(this.discards, ".");

  return discardMap;
};

function NpmDiscardChecker(rootDir, discardMap) {
  assert.ok(this instanceof NpmDiscardChecker);
  assert.ok(_.isString(rootDir));
  this.rootDir = rootDir;
  this.discardMap = discardMap;
}

var NDCp = NpmDiscardChecker.prototype;

NDCp.shouldDiscard = function(fullPath) {
  var prefix = fullPath;
  while (prefix !== this.rootDir) {
    if (hasOwn.call(this.discardMap, prefix)) {
      return this.discardMap[prefix].some(function(pattern) {
        return matches(pattern, prefix, fullPath);
      });
    }
    prefix = path.dirname(prefix);
  }
};

// TODO Cache this.
function readDir(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch (err) {
    return null;
  }
}

// TODO Improve this. For example we don't currently support wildcard
// string patterns (just use a RegExp if you need that flexibility).
function matches(pattern, prefix, fullPath) {
  var relPath = path.relative(prefix, fullPath);

  if (_.isRegExp(pattern)) {
    return relPath.match(pattern);
  }

  assert.ok(_.isString(pattern));

  if (pattern.charAt(pattern.length - 1) === path.sep &&
      fs.lstatSync(fullPath).isDirectory()) {
    relPath += path.sep;
  }

  if (pattern.charAt(0) === path.sep) {
    return relPath.indexOf(pattern.slice(1), relPath) === 0;
  }

  return relPath.indexOf(pattern) !== -1;
}

module.exports = NpmDiscards;
