var EventEmitter = require('events').EventEmitter,
    isInstance = require('is-instance');

function createPool(growSize, create, dispose){
    var pool = [];
    var index = -1;
    var totalCreated = 0;
    var totalDisposed = 0;

    return {
        size: function(){
            return pool.length;
        },
        created: function(){
            return totalCreated;
        },
        disposed: function(){
            return totalDisposed;
        },
        get: function(){
            if(index >= 0){
                var item = pool[index];
                pool[index] = null;
                index--;
                return item;
            }

            totalCreated++;
            return create();
        },
        dispose: function(object){
            totalDisposed++;
            dispose(object);
            if(index >= pool.length){
                pool = pool.concat(new Array(growSize));
            }
            index++;
            pool[index] = object;
        }
    }
}

var setPool = createPool(1000, function(){
    return new Set();
}, function(set){
    set.clear();
});

var emitKeyPool = createPool(10, function(){
    return new Map();
}, function(emitKey){
    emitKey.forEach(setPool.dispose);
    emitKey.clear();
});

function toArray(items){
    return Array.prototype.slice.call(items);
}

var deepRegex = /[|.]/i;

function matchDeep(path){
    return (path + '').match(deepRegex);
}

function isWildcardPath(path){
    var stringPath = (path + '');
    return ~stringPath.indexOf('*');
}

function getTargetKey(path){
    var stringPath = (path + '');
    return stringPath.split('|').shift();
}

var eventSystemVersion = 1,
    globalKey = '_entiEventState' + eventSystemVersion,
    globalState = global[globalKey] = global[globalKey] || {
        instances: [],
        getPoolInfo: function(){
            return [
                'setPool', setPool.size(),
                'created', setPool.created(),
                'disposed', setPool.disposed(),
                'emitKeyPool', emitKeyPool.size(),
                'created', emitKeyPool.created(),
                'disposed', emitKeyPool.disposed()
            ];
        }
    };

var modifiedEnties = globalState.modifiedEnties_v6 = globalState.modifiedEnties_v6 || setPool.get();
var trackedObjects = globalState.trackedObjects_v6 = globalState.trackedObjects_v6 || new WeakMap();
var trackedHandlers = globalState.trackedHandlers_v6 = globalState.trackedHandlers_v6 || new WeakMap();

function leftAndRest(path){
    var stringPath = (path + '');

    // Special case when you want to filter on self (.)
    if(stringPath.slice(0,2) === '.|'){
        return ['.', stringPath.slice(2)];
    }

    var match = matchDeep(stringPath);
    if(match){
        return [stringPath.slice(0, match.index), stringPath.slice(match.index+1)];
    }
    return stringPath;
}

function isWildcardKey(key){
    return key.charAt(0) === '*';
}

function isFeralcardKey(key){
    return key === '**';
}

function addHandler(object, key, handler, parentHandler){
    var trackedKeys = trackedObjects.get(object);
    var trackedHandler = trackedHandlers.get(parentHandler);

    if(trackedKeys == null){
        trackedKeys = {};
        trackedObjects.set(object, trackedKeys);
    }
    if(trackedHandler == null){
        trackedHandler = new WeakMap();
        trackedHandlers.set(parentHandler, new WeakMap());
    }

    if(trackedHandler.get(object) == null){
        trackedHandler.set(object, setPool.get());
    }

    if(trackedHandler.get(object).has(key)){
        return;
    }

    var handlers = trackedKeys[key];

    if(!handlers){
        handlers = setPool.get();
        trackedKeys[key] = handlers;
    }

    handlers.add(handler);
    trackedHandler.get(object).add(key);
}

function removeHandler(object, key, handler, parentHandler){
    var trackedKeys = trackedObjects.get(object);
    var trackedHandler = trackedHandlers.get(parentHandler);

    if(
        trackedKeys == null ||
        trackedHandler == null ||
        trackedHandler.get(object) == null ||
        !trackedHandler.get(object).has(key)
    ){
        return;
    }

    var handlers = trackedKeys[key];

    if(!handlers){
        return;
    }

    handlers.delete(handler);
    if(handlers.size === 0){
        setPool.dispose(handlers);
        delete trackedKeys[key];
    }
    var trackedObjectHandlerSet = trackedHandler.get(object);
    trackedObjectHandlerSet.delete(key);
    if(trackedObjectHandlerSet.size === 0){
        setPool.dispose(trackedObjectHandlerSet);
        trackedHandler.delete(object);
    }
}

function trackObjects(eventName, tracked, handler, object, key, path){
    if(!object || typeof object !== 'object'){
        return;
    }

    var target = object[key];

    if(target && typeof target === 'object' && tracked.has(target)){
        return;
    }

    trackObject(eventName, tracked, handler, object, key, path);
}

function trackKeys(eventName, tracked, handler, target, root, rest){
    var keys = Object.keys(target);
    for(var i = 0; i < keys.length; i++){
        if(isFeralcardKey(root)){
            trackObjects(eventName, tracked, handler, target, keys[i], '**' + (rest ? '.' : '') + (rest || ''));
        }else{
            trackObjects(eventName, tracked, handler, target, keys[i], rest);
        }
    }
}

function trackObject(eventName, tracked, handler, object, key, path){
    var eventKey = key === '**' ? '*' : key,
        target = object[key],
        targetIsObject = target && typeof target === 'object';

    var handle = function(event, emitKey){
        if(eventKey !== '*' && typeof object[eventKey] === 'object' && object[eventKey] !== target){
            if(targetIsObject){
                tracked.delete(target);
            }
            removeHandler(object, eventKey, handle, handler);
            trackObjects(eventName, tracked, handler, object, key, path);
            return;
        }

        if(eventKey === '*'){
            trackKeys(eventName, tracked, handler, object, key, path);
        }

        if(!tracked.has(object)){
            return;
        }

        if(key !== '**' || !path){
            handler(event, emitKey);
        }
    };

    addHandler(object, eventKey, handle, handler);

    if(!targetIsObject){
        return;
    }

    tracked.add(target);

    if(!path){
        return;
    }

    var rootAndRest = leftAndRest(path),
        root,
        rest;

    if(!Array.isArray(rootAndRest)){
        root = rootAndRest;
    }else{
        root = rootAndRest[0];
        rest = rootAndRest[1];

        // If the root is '.', watch for events on *
        if(root === '.'){
            root = '*';
        }
    }

    if(targetIsObject && isWildcardKey(root)){
        trackKeys(eventName, tracked, handler, target, root, rest);
    }

    trackObjects(eventName, tracked, handler, target, root, rest);
}

function emitForEnti(trackedPaths, trackedObjectPaths, eventName, emitKey, event, enti){
    var emitSet = emitKey.get(eventName);
    if(!emitSet){
        emitSet = setPool.get();
        emitKey.set(eventName, emitSet);
    }

    if(emitSet.has(enti)){
        return;
    }

    if(!trackedPaths.trackedObjects.has(enti._model)){
        trackedPaths.entis.delete(enti);
        if(trackedPaths.entis.size === 0){
            delete trackedObjectPaths[eventName];
        }
        return;
    }

    emitSet.add(enti);

    var targetKey = getTargetKey(eventName),
        value = isWildcardPath(targetKey) ? undefined : enti.get(targetKey);

    enti.emit(eventName, value, event);
}

var trackedEvents = new WeakMap();
function createHandler(enti, trackedObjectPaths, trackedPaths, eventName){
    return function(event, emitKey){
        trackedPaths.entis.forEach(emitForEnti.bind(null, trackedPaths, trackedObjectPaths, eventName, emitKey, event));
    };
}

var internalEvents = ['newListener', 'attach', 'detached', 'destroy'];
function isInternalEvent(enti, eventName){
    return ~internalEvents.indexOf(eventName) &&
        enti._events &&
        enti._events[eventName] &&
        (!Array.isArray(enti._events[eventName]) || enti._events[eventName].length === 1);
}

function trackPath(enti, eventName){
    if(isInternalEvent(enti, eventName)){
        return;
    }

    var object = enti._model,
        trackedObjectPaths = trackedEvents.get(object);

    if(!trackedObjectPaths){
        trackedObjectPaths = {};
        trackedEvents.set(object, trackedObjectPaths);
    }

    var trackedPaths = trackedObjectPaths[eventName];

    if(!trackedPaths){
        trackedPaths = {
            entis: setPool.get(),
            trackedObjects: new WeakSet()
        };
        trackedObjectPaths[eventName] = trackedPaths;
    }else if(trackedPaths.entis.has(enti)){
        return;
    }

    trackedPaths.entis.add(enti);

    var handler = createHandler(enti, trackedObjectPaths, trackedPaths, eventName);

    trackObjects(eventName, trackedPaths.trackedObjects, handler, {model:object}, 'model', eventName);
}

function trackPaths(enti){
    if(enti._events && enti._model){
        for(var key in enti._events){
            trackPath(enti, key);
        }
    }

    modifiedEnties.delete(enti);
}

function emitEvent(object, key, value, emitKey){

    modifiedEnties.forEach(trackPaths);

    var trackedKeys = trackedObjects.get(object);

    if(!trackedKeys){
        return;
    }

    var event = {
        value: value,
        key: key,
        object: object
    };

    function emitForKey(handler){
        handler(event, emitKey);
    }

    if(trackedKeys[key]){
        trackedKeys[key].forEach(emitForKey);
    }

    if(trackedKeys['*']){
        trackedKeys['*'].forEach(emitForKey);
    }
}

function emit(events){
    var emitKey = emitKeyPool.get();

    events.forEach(function(event){
        emitEvent(event[0], event[1], event[2], emitKey);
    });

    emitKeyPool.dispose(emitKey);
}

function onNewListener(){
    modifiedEnties.add(this);
}

function modelRemove(model, events, key){
    if(Array.isArray(model)){
        model.splice(key, 1);
        events.push([model, 'length', model.length]);
    }else{
        delete model[key];
        events.push([model, key]);
    }
}

function Enti(model){
    if(!(this instanceof Enti)){
        return new Enti(model);
    }

    var detached = model === false;

    if(!model || (typeof model !== 'object' && typeof model !== 'function')){
        model = {};
    }

    if(detached){
        this._model = {};
    }else{
        this.attach(model);
    }

    this.on('newListener', onNewListener);
}
Enti.emit = function(model, key, value){
    if(!(typeof model === 'object' || typeof model === 'function')){
        return;
    }

    emit([[model, key, value]]);
};
Enti.get = function(model, key){
    if(!model || typeof model !== 'object'){
        return;
    }

    key = getTargetKey(key);

    if(key === '.'){
        return model;
    }


    var path = leftAndRest(key);
    if(Array.isArray(path)){
        return Enti.get(model[path[0]], path[1]);
    }

    return model[key];
};
Enti.set = function(model, key, value){
    if(!model || typeof model !== 'object' || model === Object.prototype){
        return;
    }

    key = getTargetKey(key);

    var path = leftAndRest(key);
    if(Array.isArray(path)){
        return Enti.set(model[path[0]], path[1], value);
    }

    var original = model[key];

    if(typeof value !== 'object' && value === original){
        return;
    }

    var keysChanged = !(key in model);

    model[key] = value;

    var events = [[model, key, value]];

    if(keysChanged){
        if(Array.isArray(model)){
            events.push([model, 'length', model.length]);
        }
    }

    emit(events);
};
Enti.push = function(model, key, value){
    if(!model || typeof model !== 'object' || model === Object.prototype){
        return;
    }

    var target;
    if(arguments.length < 3){
        value = key;
        key = '.';
        target = model;
    }else{
        var path = leftAndRest(key);
        if(Array.isArray(path)){
            return Enti.push(model[path[0]], path[1], value);
        }

        target = model[key];
    }

    if(!Array.isArray(target)){
        throw new Error('The target is not an array.');
    }

    target.push(value);

    var events = [
        [target, target.length-1, value],
        [target, 'length', target.length]
    ];

    emit(events);
};
Enti.insert = function(model, key, value, index){
    if(!model || typeof model !== 'object' || model === Object.prototype){
        return;
    }


    var target;
    if(arguments.length < 4){
        index = value;
        value = key;
        key = '.';
        target = model;
    }else{
        var path = leftAndRest(key);
        if(Array.isArray(path)){
            return Enti.insert(model[path[0]], path[1], value, index);
        }

        target = model[key];
    }

    if(!Array.isArray(target)){
        throw new Error('The target is not an array.');
    }

    target.splice(index, 0, value);

    var events = [
        [target, index, value],
        [target, 'length', target.length]
    ];

    emit(events);
};
Enti.remove = function(model, key, subKey){
    if(!model || typeof model !== 'object' || model === Object.prototype){
        return;
    }

    var path = leftAndRest(key);
    if(Array.isArray(path)){
        return Enti.remove(model[path[0]], path[1], subKey);
    }

    // Remove a key off of an object at 'key'
    if(subKey != null){
        Enti.remove(model[key], subKey);
        return;
    }

    if(key === '.'){
        throw new Error('. (self) is not a valid key to remove');
    }

    var events = [];

    modelRemove(model, events, key);

    emit(events);
};
Enti.move = function(model, key, index){
    if(!model || typeof model !== 'object' || model === Object.prototype){
        return;
    }

    var path = leftAndRest(key);
    if(Array.isArray(path)){
        return Enti.move(model[path[0]], path[1], index);
    }

    if(key === index){
        return;
    }

    if(!Array.isArray(model)){
        throw new Error('The model is not an array.');
    }

    var item = model[key];

    model.splice(key, 1);

    model.splice(index, 0, item);

    emit([[model, index, item]]);
};
Enti.update = function(model, key, value, options){
    if(!model || typeof model !== 'object' || model === Object.prototype){
        return;
    }

    var target,
        isArray = Array.isArray(value);

    var events = [],
        updatedObjects = new WeakSet();

    if(typeof key === 'object'){
        options = value;
        value = key;
        key = '.';
        target = model;
    }else{
        var path = leftAndRest(key);
        if(Array.isArray(path)){
            return Enti.update(model[path[0]], path[1], value);
        }

        if(!(key in model)){
            model[key] = isArray ? [] : {};
            events.push([model, key, target]);
        }

        target = model[key];
    }

    if(typeof value !== 'object'){
        throw new Error('The value is not an object.');
    }

    if(typeof target !== 'object'){
        throw new Error('The target is not an object.');
    }

    function updateTarget(target, value){
        for(var key in value){
            var currentValue = target[key];
            var updatedValue = value[key];

            if(
                updatedValue &&
                typeof updatedValue === 'object' &&
                currentValue instanceof Object &&
                !updatedObjects.has(currentValue) &&
                !(currentValue instanceof Date)
            ){
                updatedObjects.add(currentValue);
                updateTarget(currentValue, updatedValue);
                continue;
            }

            target[key] = updatedValue;
            events.push([target, key, updatedValue]);
        }

        if(options && options.strategy === 'morph'){
            for(var key in target){
                if(!(key in value)){
                    modelRemove(target, events, key);
                }
            }
        }

        if(Array.isArray(target)){
            events.push([target, 'length', target.length]);
        }
    }

    updateTarget(target, value);

    emit(events);
};
Enti.prototype = Object.create(EventEmitter.prototype);
Enti.prototype._maxListeners = 1000;
Enti.prototype.constructor = Enti;
Enti.prototype.attach = function(model){
    if(this._model === model){
        return;
    }

    this.detach();

    if(model && !isInstance(model)){
        throw new Error('Entis may only be attached to an object, or null/undefined');
    }

    if(this._events) {
        modifiedEnties.add(this);
    }

    this._attached = true;
    this._model = model;
    this.emit('attach', model);
};
Enti.prototype.detach = function(){
    if(!this._attached){
        return;
    }
    modifiedEnties.delete(this);

    this._model = {};
    this._attached = false;
    this.emit('detach');
};
Enti.prototype.destroy = function(){
    this.detach();
    this.emit('destroy');
    this._events = undefined;
};
Enti.prototype.get = function(key){
    return Enti.get(this._model, key);
};

Enti.prototype.set = function(key, value){
    return Enti.set(this._model, key, value);
};

Enti.prototype.push = function(key, value){
    return Enti.push.apply(null, [this._model].concat(toArray(arguments)));
};

Enti.prototype.insert = function(key, value, index){
    return Enti.insert.apply(null, [this._model].concat(toArray(arguments)));
};

Enti.prototype.remove = function(key, subKey){
    return Enti.remove.apply(null, [this._model].concat(toArray(arguments)));
};

Enti.prototype.move = function(key, index){
    return Enti.move.apply(null, [this._model].concat(toArray(arguments)));
};

Enti.prototype.update = function(key, index){
    return Enti.update.apply(null, [this._model].concat(toArray(arguments)));
};
Enti.prototype.isAttached = function(){
    return this._attached;
};
Enti.prototype.attachedCount = function(){
    return modifiedEnties.size;
};

Enti.isEnti = function(target){
    return target && !!~globalState.instances.indexOf(target.constructor);
};

Enti.store = function(target, key, value){
    if(arguments.length < 2){
        return Enti.get(target, key);
    }

    Enti.set(target, key, value);
};

Enti.create = function(handlers){
    var observer = new Enti();
    observer.handlers = handlers;

    Object.keys(handlers).forEach(function(path){
        observer.on(path, handlers[path])
    });

    return observer;
};

globalState.instances.push(Enti);

module.exports = Enti;
