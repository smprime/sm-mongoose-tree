"use strict";
var mongoose = require("mongoose");
var streamWorker = require("stream-worker");
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
        var filters = args.filters || {};
        var fields = args.fields || null;
        var options = args.options || {};
        var minLevel = args.minLevel || 1;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtQ0FBcUM7QUFDckMsNENBQThDO0FBRTlDLFNBQVMsZUFBZSxDQUFHLE1BQU0sRUFBRSxPQUFRO0lBQ3ZDLElBQUksYUFBYSxHQUFHLE9BQU8sSUFBSSxPQUFPLENBQUMsYUFBYSxJQUFJLEdBQUcsRUFDckQsZ0JBQWdCLEdBQUcsT0FBTyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsRUFDdEQsUUFBUSxHQUFHLE9BQU8sSUFBSSxPQUFPLENBQUMsUUFBUSxJQUFJLFFBQVEsQ0FBQyxZQUFZO01BQy9ELFVBQVUsR0FBRyxPQUFPLElBQUksT0FBTyxDQUFDLFVBQVUsSUFBSSxDQUFDLEVBQy9DLE1BQU0sR0FBRyxPQUFPLElBQUksT0FBTyxDQUFDLE1BQU0sSUFBSSxRQUFRLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFDOUQsa0JBQWtCLEdBQUcsR0FBRyxHQUFHLGFBQWEsR0FBRyxHQUFHLENBQUM7SUFFckQ7Ozs7O09BS0c7SUFDSCxNQUFNLENBQUMsR0FBRyxDQUFDO1FBQ1AsTUFBTSxFQUFFO1lBQ0osSUFBSSxFQUFFLE1BQU07WUFDWixHQUFHLEVBQUUsVUFBVSxHQUFHO2dCQUNkLE9BQU8sQ0FBQyxHQUFHLFlBQVksTUFBTSxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO1lBQzlELENBQUM7WUFDRCxLQUFLLEVBQUUsSUFBSTtTQUNkO1FBQ0QsSUFBSSxFQUFFO1lBQ0YsSUFBSSxFQUFFLE1BQU07WUFDWixLQUFLLEVBQUUsSUFBSTtTQUNkO0tBQ0osQ0FBQyxDQUFDO0lBR0g7Ozs7O09BS0c7SUFDSCxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxTQUFTLE9BQU8sQ0FBQyxJQUFJO1FBQ3BDLElBQUksY0FB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