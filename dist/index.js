"use strict";
var mongoose = require("mongoose");
var streamWorker = require("stream-worker");
var _ = require("lodash");
function getChildrenTree(schema, options) {
    var pathSeparator = options && options.pathSeparator || '#', wrapChildrenTree = options && options.wrapChildrenTree, onDelete = options && options.onDelete || 'DELETE' //'REPARENT'
    , numWorkers = options && options.numWorkers || 5, idType = options && options.idType || mongoose.Schema.ObjectId, pathSeparatorRegex = '[' + pathSeparator + ']';
    /**
     * Add parent and path properties
     *
     * @property {ObjectID} parent
     * @property {String} path
     */
    schema.add({
        parent: {
            type: idType,
            set: function (val) {
                return (val instanceof Object && val._id) ? val._id : val;
            },
            index: true
        },
        path: {
            type: String,
            index: true
        }
    });
    /**
     * Pre-save middleware
     * Build or rebuild path when needed
     *
     * @param  {Function} next
     */
    schema.pre('save', function preSave(next) {
        var isParentChange = this.isModified('parent');
        if (this.isNew || isParentChange) {
            if (!this.parent) {
                this.path = this._id.toString();
                return next();
            }
            var self = this;
            this.collection.findOne({ _id: this.parent }, function (err, doc) {
                if (err) {
                    return next(err);
                }
                var previousPath = self.path;
                self.path = doc.path + pathSeparator + self._id.toString();
                if (isParentChange) {
                    // When the parent is changed we must rewrite all children paths as well
                    self.collection.find({ path: { '$regex': '^' + previousPath + pathSeparatorRegex } }, function (err, cursor) {
                        if (err) {
                            return next(err);
                        }
                        streamWorker(cursor.stream(), numWorkers, function streamOnData(doc, done) {
                            var newPath = self.path + doc.path.substr(previousPath.length);
                            self.collection.update({ _id: doc._id }, { $set: { path: newPath } }, done);
                        }, next);
                    });
                }
                else {
                    next();
                }
            });
        }
        else {
            next();
        }
    });
    /**
     * Pre-remove middleware
     *
     * @param  {Function} next
     */
    schema.pre('remove', function preRemove(next) {
        if (!this.path)
            return next();
        if (onDelete == 'DELETE') {
            this.collection.remove({ path: { '$regex': '^' + this.path + pathSeparatorRegex } }, next);
        }
        else {
            var self = this, newParent = this.parent, previousParent = this._id;
            // Update parent property from children
            this.collection.find({ parent: previousParent }, function (err, cursor) {
                if (err) {
                    return next(err);
                }
                streamWorker(cursor.stream(), numWorkers, function streamOnData(doc, done) {
                    self.collection.update({ _id: doc._id }, { $set: { parent: newParent } }, done);
                }, function streamOnClose(err) {
                    if (err) {
                        return next(err);
                    }
                    self.collection.find({ path: { $regex: previousParent + pathSeparatorRegex } }, function (err, cursor) {
                        var subStream = cursor.stream();
                        streamWorker(subStream, numWorkers, function subStreamOnData(doc, done) {
                            var newPath = doc.path.replace(previousParent + pathSeparator, '');
                            self.collection.update({ _id: doc._id }, { $set: { path: newPath } }, done);
                        }, next);
                    });
                });
            });
        }
    });
    /**
     * @method getChildren
     *
     *         {Object}        filters (like for mongo find) (optional)
     *  {Object} or {String}   fields  (like for mongo find) (optional)
     *         {Object}        options (like for mongo find) (optional)
     * @param  {Boolean}       recursive, default false      (optional)
     * @param  {Function}      next
     * @return {Model}
     */
    schema.methods.getChildren = function getChildren(filters, fields, options, recursive, next) {
        // normalize the arguments
        if ('function' === typeof filters) {
            next = filters;
            filters = {};
        }
        else if ('function' === typeof fields) {
            next = fields;
            fields = null;
            if ('boolean' === typeof filters) {
                recursive = filters;
                filters = {};
            }
        }
        else if ('function' === typeof options) {
            next = options;
            options = {};
            if ('boolean' === typeof fields) {
                recursive = fields;
                fields = null;
            }
        }
        else if ('function' === typeof recursive) {
            next = recursive;
            if ('boolean' === typeof options) {
                recursive = options;
                options = {};
            }
            else {
                recursive = false;
            }
        }
        filters = filters || {};
        fields = fields || null;
        options = options || {};
        recursive = recursive || false;
        if (recursive) {
            if (filters['$query']) {
                filters['$query']['path'] = { $regex: '^' + this.path + pathSeparatorRegex };
            }
            else {
                filters['path'] = { $regex: '^' + this.path + pathSeparatorRegex };
            }
        }
        else {
            if (filters['$query']) {
                filters['$query']['parent'] = this._id;
            }
            else {
                filters['parent'] = this._id;
            }
        }
        return this.model(this.constructor.modelName).find(filters, fields, options, next);
    };
    /**
     * @method getParent
     *
     * @param  {Function} next
     * @return {Model}
     */
    schema.methods.getParent = function getParent(next) {
        return this.model(this.constructor.modelName).findOne({ _id: this.parent }, next);
    };
    /**
     * @method getAncestors
     *
     * @param  {Object}   args
     * @param  {Function} next
     * @return {Model}
     */
    schema.methods.getAncestors = function getAncestors(filters, fields, options, next) {
        if ('function' === typeof filters) {
            next = filters;
            filters = {};
        }
        else if ('function' === typeof fields) {
            next = fields;
            fields = null;
        }
        else if ('function' === typeof options) {
            next = options;
            options = {};
        }
        filters = filters || {};
        fields = fields || null;
        options = options || {};
        var ids = [];
        if (this.path) {
            ids = this.path.split(pathSeparator);
            ids.pop();
        }
        if (filters['$query']) {
            filters['$query']['_id'] = { $in: ids };
        }
        else {
            filters['_id'] = { $in: ids };
        }
        return this.model(this.constructor.modelName).find(filters, fields, options, next);
    };
    /**
     * @method getChildrenTree
     *
     * @param  {Document} root (optional)
     * @param  {Object}   args (optional)
     *         {Object}        .filters (like for mongo find)
     *  {Object} or {String}   .fields  (like for mongo find)
     *         {Object}        .options (like for mongo find)
     *         {Number}        .minLevel, default 1
     *         {Boolean}       .recursive
     *         {Boolean}       .allowEmptyChildren
     * @param  {Function} next
     * @return {Model}
     */
    schema.statics.getChildrenTree = function getChildrenTree(root, args, next) {
        if ("function" === typeof (root)) {
            next = root;
            root = null;
            args = {};
        }
        else if ("function" === typeof (args)) {
            next = args;
            if ("model" in root) {
                args = {};
            }
            else {
                args = root;
                root = null;
            }
        }
        var filters = _.has(args, 'filters') ? args.filters : {};
        var fields = _.has(args, 'fields') ? args.fields : null;
        var options = _.has(args, 'options') ? args.options : {};
        var minLevel = _.has(args, 'minLevel') ? args.minLevel : 1;
        var recursive = args.recursive != undefined ? args.recursive : true;
        var allowEmptyChildren = args.allowEmptyChildren != undefined ? args.allowEmptyChildren : true;
        if (!next)
            throw new Error('no callback defined when calling getChildrenTree');
        // filters: Add recursive path filter or not
        if (recursive) {
            if (root) {
                filters.path = { $regex: '^' + root.path + pathSeparatorRegex };
            }
            if (filters.parent === null) {
                delete filters.parent;
            }
        }
        else {
            if (root) {
                filters.parent = root._id;
            }
            else {
                filters.parent = null;
            }
        }
        // fields: Add path and parent in the result if not already specified
        if (fields) {
            if (fields instanceof Object) {
                if (!fields.hasOwnProperty('path')) {
                    fields['path'] = 1;
                }
                if (!fields.hasOwnProperty('parent')) {
                    fields['parent'] = 1;
                }
            }
            else {
                if (!fields.match(/path/)) {
                    fields += ' path';
                }
                if (!fields.match(/parent/)) {
                    fields += ' parent';
                }
            }
        }
        // options:sort , path sort is mandatory
        if (!options.sort) {
            options.sort = {};
        }
        options.sort.path = 1;
        if (options.lean == null) {
            options.lean = !wrapChildrenTree;
        }
        return this.find(filters, fields, options, function (err, results) {
            if (err) {
                return next(err);
            }
            var getLevel = function (path) {
                return path ? path.split(pathSeparator).length : 0;
            };
            var createChildren = function createChildren(arr, node, level) {
                if (level == minLevel) {
                    if (allowEmptyChildren) {
                        node.children = [];
                    }
                    return arr.push(node);
                }
                var nextIndex = arr.length - 1;
                var myNode = arr[nextIndex];
                if (!myNode) {
                    //console.log("Tree node " + node.name + " filtered out. Level: " + level + " minLevel: " + minLevel);
                    return [];
                }
                else {
                    createChildren(myNode.children, node, level - 1);
                }
            };
            var finalResults = [];
            var rootLevel = 1;
            if (root) {
                rootLevel = getLevel(root.path) + 1;
            }
            if (minLevel < rootLevel) {
                minLevel = rootLevel;
            }
            for (var r in results) {
                var level = getLevel(results[r].path);
                createChildren(finalResults, results[r], level);
            }
            next(err, finalResults);
        });
    };
    schema.methods.getChildrenTree = function (args, next) {
        this.constructor.getChildrenTree(this, args, next);
    };
    /**
     * @property {Number} level <virtual>
     */
    schema.virtual('level').get(function virtualPropLevel() {
        return this.path ? this.path.split(pathSeparator).length : 0;
    });
}
module.exports = getChildrenTree;
module.exports.default = getChildrenTree;
Object.defineProperty(module.exports, "__esModule", { value: true });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtQ0FBcUM7QUFDckMsNENBQThDO0FBQzlDLDBCQUEyQjtBQUUzQixTQUFTLGVBQWUsQ0FBQyxNQUFNLEVBQUUsT0FBUTtJQUNyQyxJQUFJLGFBQWEsR0FBRyxPQUFPLElBQUksT0FBTyxDQUFDLGFBQWEsSUFBSSxHQUFHLEVBQ3JELGdCQUFnQixHQUFHLE9BQU8sSUFBSSxPQUFPLENBQUMsZ0JBQWdCLEVBQ3RELFFBQVEsR0FBRyxPQUFPLElBQUksT0FBTyxDQUFDLFFBQVEsSUFBSSxRQUFRLENBQUMsWUFBWTtNQUMvRCxVQUFVLEdBQUcsT0FBTyxJQUFJLE9BQU8sQ0FBQyxVQUFVLElBQUksQ0FBQyxFQUMvQyxNQUFNLEdBQUcsT0FBTyxJQUFJLE9BQU8sQ0FBQyxNQUFNLElBQUksUUFBUSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQzlELGtCQUFrQixHQUFHLEdBQUcsR0FBRyxhQUFhLEdBQUcsR0FBRyxDQUFDO0lBRXJEOzs7OztPQUtHO0lBQ0gsTUFBTSxDQUFDLEdBQUcsQ0FBQztRQUNQLE1BQU0sRUFBRTtZQUNKLElBQUksRUFBRSxNQUFNO1lBQ1osR0FBRyxFQUFFLFVBQVUsR0FBRztnQkFDZCxPQUFPLENBQUMsR0FBRyxZQUFZLE1BQU0sSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQztZQUM5RCxDQUFDO1lBQ0QsS0FBSyxFQUFFLElBQUk7U0FDZDtRQUNELElBQUksRUFBRTtZQUNGLElBQUksRUFBRSxNQUFNO1lBQ1osS0FBSyxFQUFFLElBQUk7U0FDZDtLQUNKLENBQUMsQ0FBQztJQUdIOzs7OztPQUtHO0lBQ0gsTUFBTSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsU0FBUyxPQUFPLENBQUMsSUFBSTtR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