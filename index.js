// Dependencies
var request   = require('request'),
    merge     = require('merge'),
    clone     = require('clone'),
    util      = require('util'),
    events    = require('events'),
    x2j       = require('rapidx2j'),
    csv       = require('csv'),
    moment    = require('moment'),
    transform = require('json-transmute'),
    fs        = require('fs');
    
// Module exports
module.exports = Resting;

// Constructor
function Resting(options) {
  var root = this;
  
  options        = options || {};
  this.path      = options.path || './services/';
  this.providers = JSON.parse(fs.readFileSync(this.path + 'providers.json'));
  this.quotas    = {};
  this.services  = {};
  
  this.authProviders = {};
  
  this.globalTokens = { 
    '@utc': function() { return new Date().toISOString(); } 
  };
  
  this.parseXmlParams = {
    preserve_case: true,
    parse_boolean_values: false,
    parse_int_numbers: false,
    parse_float_numbers: false,    
  }
  
  /** Begin adding services */
  Object.keys(this.providers).forEach(function(provider) {
    var servicesFile = root.providers[provider].servicesFile,
        dataMapFile  = root.providers[provider].dataMapFile;
        
    if (dataMapFile) {
      var dataMap = JSON.parse(fs.readFileSync(root.path + dataMapFile));
    }
        
    root.providers[provider].name     = provider;        
    root.providers[provider].services = {};
    root.providers[provider].quotas   = {};
    root.providers[provider].dataMap  = dataMap || {};

    if (servicesFile) {
      var services = JSON.parse(fs.readFileSync(root.path + servicesFile));
      root.addServices(root.providers[provider], services.services);
    }    
  });
  
  /** Begin processing EventEmitter events */
  events.EventEmitter.call(this);
}

/** Extend Resting as an EventEmitter */
util.inherits(Resting, events.EventEmitter);

Resting.prototype.call = function(service, provider, inputs, callback) {
  var root = this;

  if (!provider) {
    Object.keys(this.providers).forEach(function(key) {
      root.call(service, key, inputs, callback);
    });
  } else if (typeof provider === 'object') {
    Object.keys(this.providers).forEach(function(key) {
      root.call(service, key, provider, inputs);
    });
  } else if (Array.isArray(provider)) {
    provider.forEach(function(key) {
      root.call(service, key, inputs, callback);
    });
  } else if (provider in this.providers && this.providers[provider].services
    && service in this.providers[provider].services) {
      this.providers[provider].services[service](inputs, callback);
  } else {
    throw new Error('Provider or service not found: [ ' + provider + ', ' + service + ' ]');
  }
}

/** 
  * Add provider specific request replacement
  *
  * Allow drop in replacements for request on a per-provider basis.  Enables
  * custom authorization / request signage (e.g. Amazon)
  *
  * @this {Resting}
  * @param {string} provider Provider name whose services will use auth
  * @param {callback} auth Request replacement function
  */
Resting.prototype.addAuthProvider = function(provider, auth) {
  this.authProviders[provider] = auth;
}

/**
 * Add new services
 *
 * Add all services defined in the services JSON file passed in to the object
 * constructor.  This is a recursive process as the services JSON file is
 * provided in a tree format.  This facilitates brevity within the services
 * definition file(s).
 * 
 * @this {Resting}
 * @param {array} services Array of services (or child services) to process
 * @param {object} parentBuild Parent service parameters object
 */
Resting.prototype.addServices = function(provider, services, parentBuild) {
  var root  = this;
  
  parentBuild            = parentBuild            || {};
  parentBuild.parameters = parentBuild.parameters || {};
  parentBuild.listParams = parentBuild.listParams || {};

  /** Iterate over each service or child service */
  services.forEach(function(service) {
  
    /** Clone the parent service parameters object.  This ensures that we don't
      * update this object as we recursively generate child services. */
    build = clone(parentBuild);

    /** Iterate over each service attribute and process accordingly */
    Object.keys(service).forEach(function(key) {
      switch(key) {
        case 'name':
          //@TODO remove this - remnant of Amazon-only use
          //build.parameters['Action'] = service[key];
          build[key] = service[key];
        break;
        //case 'body':
        case 'parameters':
          build[key] = build[key] || {};
          
          /** Copy each key / value pair over to the build object. This ensures
            * we maintain all of the parent key / values as well when this
            * function is called recursively. */
          Object.keys(service[key]).forEach(function(paramKey) {
            build[key][paramKey] = service[key][paramKey];
          });
        break;
        case 'children':
        break;
        default:
          build[key] = service[key];
        break;
      }
    });
    
    /** If children are present, process them recursively.  If not, then we
      * have reached the end and now have a fully defined service. Add it. */
    if ('children' in service) {
      root.addServices(provider, service.children, build);
    } else {
      root.addService(provider, build);
    }    
  });
}

/**
 * Provide a method to access a service
 *
 * Prototype a function on the Resting object that provides access to a 
 * specific service as defined the service build object.
 * 
 * @this {Resting}
 * @param {object} build Service creation parameters
 */
Resting.prototype.addService = function(provider, service) {
  var root     = this,
      aliasArr = service.alias || [];
      
  /** Initialize quota for this service */
  this.initQuota(provider, service);
  
  /** Build the service call */
  provider.services[service.name] = function(inputs, callback) {
  
    /** Clone the service definition object so that we don't disrupt defaults */
    var build = clone(service);
    
    /** Ensure build.quota is referenced directly to service.quota, and add the
      * raw tokens to the service build object in case they are needed later */
    build.quota  = service.quota;    
    build.inputs = inputs || {};
    
    /** If a callback has been provided, add it to the service build object */
    if (callback && typeof callback === "function") build.callback = callback;
        
    /** Calls to services that consume quotas on a per-item basis are broken
      * down and called individually on a per-item basis. */
    if (root.invokeServicePerItem(provider, service, build.inputs)) return;
    
    /** Include global tokens in service parameters */
    Object.keys(root.globalTokens).forEach(function(key) {
      if (!(key in build.inputs)) build.inputs[key] = root.globalTokens[key];
    });    
  
    /** Include credentials in service parameters */
    Object.keys(provider.tokens || {}).forEach(function(key) {
      build.inputs['@' + key] = provider.tokens[key];
    });
    
    /** Perform token individual token replacements */
    //build.endpoint = root.tokenReplace(build.endpoint, build.inputs);
    //build.path = root.tokenReplace(build.path, build.inputs);
    
    /** Perform object token replacements */
    root.tokenReplaceAll(build, build.inputs);
    //if ('parameters' in build) 
    //  root.tokenReplaceAll(build.parameters, build.inputs);
    //if ('body' in build) 
    //  root.tokenReplaceAll(build.body, build.inputs);
      
    /** Queue the service */
    root.queueService(provider, build);    
  }
  
  /** Ensure aliases are in array format */
  aliasArr = Array.isArray(aliasArr) ? aliasArr : [ aliasArr ];

  /** Map alias service calls to primary service call */
  aliasArr.forEach(function(alias) {
    provider.services[alias] = 
      provider.services[service.name];
  });
}

/**
 * Perform parameter token replacement for object key / values
 *
 * Iterate over an object's keys and performs token replacement using the values
 * contained within inputs.
 * 
 * @this {Resting}
 * @param {object} parameters Service parameters requiring replacement
 * @param {object} inputs Replacement values
 */
Resting.prototype.tokenReplaceAll = function(params, inputs, subLevel) {
  var regExp = new RegExp('\{\{(.+?)\}\}', 'g'),
      root   = this;
      
  /** Iterate over each parameter defined for this service */
  Object.keys(params || {}).forEach(function(key) {
    var newKey;     
    
    /** Perform key token replacement */
    while (tokenMatch = regExp.exec(key)) {
      if (tokenMatch[1] in inputs) {
        newKey = key.replace(tokenMatch[0], inputs[tokenMatch[1]]);
        
        params[newKey] = params[key];
        delete params[key];
        
        key = newKey;
      }
    }
    
    if (typeof params[key] === 'object') {
      root.tokenReplaceAll(params[key], inputs, true);
      return;
    }
    
    /** Iteratively search for tokens via regular expression matching. 
      * A given parameter may contain more than one replacement token. */
    while (tokenMatch = regExp.exec(params[key])) {
    
      var tokenSymbol = tokenMatch[0],
          tokenName   = tokenMatch[1]; 
          
      /** Perform token replacement */
      if (tokenName in inputs) {    
        var tokenValue = inputs[tokenName];
      
        /** If the index token is present in the parameter name, then we
          * assume we are generating an array of properties, and updating
          * both the key and the value of the paramter */
        if (key.indexOf('{{@index}}') >= 0) {
          if (!Array.isArray(tokenValue)) tokenValue = [ tokenValue ];
        
          for (var i in tokenValue) {
            params[key.replace('{{@index}}', i * 1 + 1)] = tokenValue[i];
          }
          
          delete params[key];
        } else if (typeof tokenValue === 'object') {
          params[key] = tokenValue;
        } else {
          params[key] = params[key].replace(tokenSymbol, tokenValue);
        }
      } else if (subLevel) {
        delete params[key];
      }
    }
  });
}

/**
 * Perform parameter token replacement for a given string value
 * 
 * @this {Resting}
 * @param {object} parameters Service parameters requiring replacement
 * @param {object} inputs Replacement values
 */
Resting.prototype.tokenReplace = function(value, inputs) {
  var regExp = new RegExp('\{\{(.+?)\}\}', 'gm');

  while (tokenMatch = regExp.exec(value)) {
    var tokenSymbol = tokenMatch[0],
        tokenName   = tokenMatch[1],
        replaceExp  = new RegExp(tokenSymbol, 'gm'); 
  
    /** Perform token replacement */
    if (tokenName in inputs) {
      value = value.replace(replaceExp, inputs[tokenName]);
    }
  }
  
  return value;
}

/**
 * Intialize quota for services.
 *
 * Services may specify a quota pool for requests to be managed by this object.
 * Further, One or more services may share a common quota pool.  We initialize
 * quota pools here when services are first defined.  Services with shared 
 * pools will specify a quotaGroup parameter.
 * 
 * @this {Resting}
 * @param {object} tokens Token key value pairs
 */
Resting.prototype.initQuota = function(provider, service) {
  if (service.quotaPool) {
    service.quotaGroup = service.quotaGroup || service.name;
    
    if (!provider.quotas[service.quotaGroup]) {
      var restoreMS = moment.duration(service.quotaRestore || '00:00:01');
    
      provider.quotas[service.quotaGroup] = {
        queue:     [],
        available: parseInt(service.quotaPool),
        restore:   restoreMS.asMilliseconds(),
      };
    }
  }  
}

/**
 * Consume quota for a related service call
 *
 * Whenever a service call is made for a service with a quota, we must update
 * the available call pool.  Service call quota availability pools can represent
 * one of two things depending upon quotaType: the number of available calls 
 * (default), or the number of available items that can be requested during a 
 * given time window across any number of calls. For the latter we look for 
 * fields passed in to the service call that are listed in quotaFields.  If more 
 * than one field is present from quotaFields in a given call, the field with 
 * the largest number of items will be used to decrement the available pool.
 *
 * @this {Resting}
 * @param {object} quota Quota definition object
 */
Resting.prototype.consumeQuota = function(provider, service) {
  var quota      = provider.quotas[service.quotaGroup],
      fields     = service.quotaFields,
      itemCounts = [];
      
  if (!quota) return;
  
  /** Decrement the available call pool depending on quotaType */
  if (service.quotaType == 'perItem' && fields && fields.length) {
  
    /** Build an array of item counts for each quotaField present in the 
      * parameters (tokens) passed into to this service call */
    fields.forEach(function(field) {
      if (field in service.tokens) {
        itemCounts.push(service.tokens[field].length || 1);
      }    
    });
    
    /** Decrement the available call pool by the largest item count recorded */
    quota.available -= Math.max(itemCounts);
  } else {
    --quota.available;
  }
}

/**
 * Update quota for a related service call
 *
 * Whenever a service call is made for a service with a quota, we must update
 * the available call pool and attach an interval function to restore the 
 * available call pool or invoke any services backlogged in the queue as calls
 * become available.
 *
 * @this {Resting}
 * @param {object} quota Quota definition object
 */
Resting.prototype.restoreQuota = function(provider, service, offset) {
  var quota = provider.quotas[service.quotaGroup],
      root  = this;
  
  /** If we are already updating this quota, we're done. */
  if (quota.update) return;
  
  /** Define an interval function that runs every quotaRestore milliseconds.
    * Each iteration represents an available service call for processing the
    * queue (if populated) or restoring the available call pool (if not). */
  quota.update = setInterval(function() {
    if (quota.queue.length) {
      root.invokeService(provider, quota.queue.shift());
    } else {
      ++quota.available;
      
      /** If we've fully restored the available call pool, stop monitoring */
      if (quota.available >= service.quotaPool) {
        clearInterval(quota.update);
        delete quota.update;
      }
    }
  }, quota.restore);
}

/**
 * Queue a service for execution.
 *
 * Services with quotas are limited to the number of calls they can make during
 * a given window of time.  Determine whether or not the specified service is
 * available immediately for call.  Available services (and services without
 * quotas) are called immediately.
 * 
 * @this {Resting}
 * @param {object} service Service definition object
 */
Resting.prototype.queueService = function(provider, service) {
  var quotaGroup = service.quotaGroup || service.name,
      quota      = provider.quotas[quotaGroup];
      
  /** If no quotas have been defined for this service, invoke it and return */
  if (!service.quotaPool || quota.available) {
    this.consumeQuota(provider, service);  
    this.invokeService(provider, service);
  } else {
    quota.queue.push(service);
  }
}

/**
 * Invoke a service on a per-item basis.
 *
 * Service quotas may be consumed on a per call basis (default) or they may be
 * consumed on a per item basis.  The latter method is used when quotaField has
 * been specified, and is present in the parameters passed to a service call.
 * In order to simplify the quota management process, we convert single service
 * calls into multiple calls - one for each item.  While this does increase
 * network overhead, it greatly reduces the complexity of the quota management
 * logic required.
 *
 * @this {Resting}
 * @param {object} service Service definition object
 * @param {object} tokenValues Token values used to populate the service call
 * @return {boolean} True if the service call should be processed per-item
 */
Resting.prototype.invokeServicePerItem = function(provider, service, tokens) {
  var itemField = clone(tokens[service.quotaField]),
      root = this;
  
  /** Process this call normally if quotaField is absent from tokenValues or if
    * tokenValues[quotaField] represents a single value */
  if (!itemField || !Array.isArray(itemField) || itemField.length <= 1) {
    return false;
  }
  
  /** Call the service once for each item in itemField */
  itemField.forEach(function(item) {
    tokens[service.quotaField] = item;
    provider.services[service.name](tokens);    
  });
  
  return true;
}


/**
 * Invoke a service.
 *
 * Build and execute a service request.
 * 
 * @this {Resting}
 * @param {object} service Service definition object
 */
Resting.prototype.invokeService = function(provider, service) {
  var params     = service.parameters,
      root       = this,
      query      = [];
      
  /** Configure default request method */
  var authorize = this.authProviders[provider] || request;
      
  /** Service request method defaults to GET */
  service.method = service.method || 'GET';
    
  /** Build array of url query parameters. */
  Object.keys(params).sort().forEach(function (key) {
    query.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
  });
  
  /** Build final request */
  // @TODO add no-SSL option
  var requestOptions = {
    url: 'https://' + service.endpoint + service.path + '?' + query.join('&'),
    method: service.method || 'GET',
    headers: service.headers || {},
    json: service.format === 'JSON',
  }
  
  /** If a service body has been defined, and it contains a child with 
    * the reserved key '@body', set the request body to be the direct contents
    * of the associated value. Any other keys present will be discarded. */       
  if (service.body && service.body['@body']) {
    service.body = service.body['@body'];
  }
  
  /** Add body data to request if present, and content MD5 header. Serialize
    * body object if it is in object form */
  // @TODO check for XML body type and handle appropriately
  if (service.body) {
    if (typeof service.body === 'object' 
      && !requestOptions.json && !service.format === 'XML') {
        service.body = qs.stringify(service.body);
    }
    
    requestOptions.body = service.body;
  }
  
  /** If service.form has been specified, format request as a form data
    * submission */
  if (service.form) {
    requestOptions.method = 'POST';
    requestOptions.form = service.form;
  }
  
  /** Send service request */
  authorize(requestOptions, function(err, response, body) {
    var csvOptions = service.formatOptions || { columns: true };
    
    /** Store the original response body on the service response object */
    service.bodyRaw = body;
            
    /** Update quota pool and queue for this service if present */
    if (service.quotaPool) root.restoreQuota(provider, service);
    
    if (err) {
      throw err;
      return;
    }

    /** Parse service response based upon the content-type header */
    switch (service.format.toUpperCase()) {
      case 'CSV':
        csv.parse(body, csvOptions, function(err, output) {
          if (err) throw err;
        
          service.bodyParsed = { payload: output };
          root.returnService(provider, service);
        });
      break;
      case 'XML':
        service.bodyParsed = x2j.parse(body, root.parseXmlParams);
        root.returnService(provider, service);
      break;
      case 'JSON':
        service.bodyParsed = body;
        root.returnService(provider, service);
      break;
      default:
        service.bodyParsed = body;
        root.returnService(provider, service);
      break;
    }        
  });
}

/**
 * Provide a service response.
 *
 * Parsing service response data is often done asynchronously, so we define a
 * seperate function here for evoking completion callbacks and emitting the
 * response event.
 * 
 * @this {Resting}
 * @param {object} service Service response object
 */
Resting.prototype.returnService = function(provider, service) {
  var dataMap   = service.inputs.dataMap || provider.dataMap,
      dataMerge = service.inputs.dataMerge,
      mapKey    = service.map || service.name,
      event     = service.event || service.name;
      
  /** If dataMerge was included in inputs, add it to the response */
  if (dataMerge) {
    service.bodyParsed = merge.recursive(service.bodyParsed, dataMerge);
  }

  /** If dataMerge was specified for the provider, add it to the response */
  if ('dataMerge' in provider) {
    service.bodyParsed = merge.recursive(service.bodyParsed, provider.dataMerge);
  }

  /** Transform the response body */
  if (mapKey in dataMap) {
    service.bodyFinal = transform(service.bodyParsed, dataMap[mapKey]);
  } else {
    service.bodyFinal = service.bodyParsed;
  }
  
  /** Invoke callback is one of was provided */
  if (service.callback) {
    service.callback(service.bodyFinal, provider, service);  
  } else if (service.inputs.callback) {
    service.inputs.callback(service.bodyFinal, provider, service);
  }

  /** Emit event for this service's completion */
  this.emit(event, service.bodyFinal, provider, service);    
}

Resting.prototype.getProviders = function(hasTag) {
  var providers = [],
      root      = this;
  
  Object.keys(this.providers).forEach(function(name) {
    if (!hasTag || (root.providers[name].tags || []).indexOf(hasTag) > -1) {
      providers.push(root.providers[name]);
    }
  });
  
  return providers;
}

Resting.prototype.getProvider = function(provider) {
  return this.providers[provider] || {};
}

