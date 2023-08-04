const WebSocket = require('ws')
const _ = require('lodash')
const request = require('request')
const debug = require('debug')('signalk-cloud')
const uuidv4 = require('uuid').v4

const staticKeys = [
  "name",
  "mmsi",
  "uuid",
  "url",
  "flag",
  "port",
  "design.aisShipType",
  "design.draft",
  "design.length",
  "design.beam",
  "design.keel",
  "design.airHeight",
  "design.rigging",
  "sensors.gps.fromCenter",
  "sensors.gps.fromBow"
];

const otherVesselsPaths = [
  "design.*",
  "sensors.*",
  "name",
  "mmsi",
  "flag",
  "port",
  "mothershipMmsi",
  "url",
  "serverName",
  "atonType",
  "serverVersion"
];

module.exports = function(app) {
  var plugin = {};
  var connectionInfos = {}
  var options
  var positionSubscriptions = {}
  let selfContext = 'vessels.' + app.selfId
  var statusMessage
  var hadError = false

  plugin.id = "signalk-cloud";
  plugin.name = "SignalK Cloud";
  plugin.description = "Plugin that updates and retrieves data from a SignalK cloud server";

  const setProviderStatus = app.setProviderStatus
        ? (msg) => {
          app.setProviderStatus(msg)
          statusMessage = msg
        } : (msg) => { statusMessage = msg }

  const setProviderError = app.setProviderError
        ? (msg) => {
          app.setProviderError(msg)
          statusMessage = `error: ${msg}`
        } : (msg, type) => { statusMessage = `error: ${msg}` }
  
  plugin.statusMessage = () => {
    return statusMessage
  }
  
  plugin.start = function(theOptions) {
    options = theOptions;

    /*
    if ( typeof options.jwtToken === 'undefined'
         || options.jwtToken.length == 0 )
    {
      setProviderError('no jwt token configured')
      console.log('signalk-cloud: ERROR no jwt token specified')
      return;
    }
    */

    if ( _.isUndefined(options.enabled) || options.enabled ) {
      connect(options)
    }
    if ( options.otherServers ) {
      options.otherServers.forEach(settings => {
        if ( settings.enabled ) {
          connect(settings)
        }
      })
    }
  };

  function connect(settings)
  {
    var url

    //try to support old config which had the ws url
    if ( settings.url.startsWith("ws:") ) {
      url = "http:" + settings.url.substring(3);
    } else if ( settings.url.startsWith("wss:") ) {
      url = "https:" + settings.url.substring(4);
    } else {
      url = settings.url
    }

    let positionSubscription = app.getSelfPath("navigation.position")
    
    if ( !_.isUndefined(positionSubscription) && !_.isUndefined(positionSubscription.value) ) {
      positionSubscription = positionSubscription.value
    }

    if ( !_.isUndefined(positionSubscription) && (_.isUndefined(positionSubscription.latitude) || _.isUndefined(positionSubscription.longitude)) ) {
      positionSubscription = null
    }
    
    app.debug(`myposition: ${JSON.stringify(positionSubscription)}`)

    let info = connectionInfos[settings.url]
    
    if ( !info ) {
      info = {
        onStop: [],
        positionSubscriptionSent: false,
        settings
      }
      connectionInfos[settings.url] = info
    }

    var infoUrl = url + '/signalk'
    app.debug(`trying ${infoUrl}`)
    request(infoUrl, function (error, response, body) {
      if ( error )
      {
        const msg = `Error connecting to cloud server ${error.message}`
        setProviderError(msg)
        app.error(msg)
        if ( ! info.reconnectTimer ) {
          info.reconnectTimer = setInterval(() => {
            connect(settings)
          }, 10000)
        }
        return
      } else if ( response.statusCode != 200 ) {
        const msg = `Bad status code from cloud server ${response.statusCode}`
        setProviderError(msg)
        app.error(msg)
        if ( !info.reconnectTimer ) {
          info.reconnectTimer = setInterval(() => {
            connect(settings)
          }, 10000)
        }
        return
      }

      var serverInfo = JSON.parse(body)

      app.debug(`server info ${JSON.stringify(serverInfo)}`)
      
      var endpoints = serverInfo.endpoints.v1

      if ( settings.serverUpdatePeriod < 10 ) {
        settings.serverUpdatePeriod = 10
      }

      if ( settings.staticUpdateRate < 5 ) {
        settings.staticUpdateRate = 5
      }
      
      var wsUrl = (endpoints['signalk-ws'] ? endpoints['signalk-ws'] : endpoints['signalk-wss']) + `?subscribe=none&updateRate=${settings.serverUpdatePeriod}&staticUpdateRate=${settings.staticUpdatePeriod}`
      var httpURL = (endpoints['signalk-https'] ? endpoints['signalk-https'] : endpoints['signalk-http'])

      if ( !httpURL.endsWith('/') ) {
        httpURL = httpURL + '/'
      }

      const msg = `trying to connect to: ${wsUrl}`
      setProviderStatus(msg)
      app.debug(msg)

      var wsOptions = {}
      
      if ( typeof settings.jwtToken !== 'undefined'
           && settings.jwtToken.length > 0 ) {
        wsOptions.headers = { 'Authorization': 'JWT ' + settings.jwtToken }
        info.hasToken = true
      } else {
        info.hasToken = false
      }

      let connection
      try
      {
        connection = new WebSocket(wsUrl, "ws", wsOptions);
      }
      catch ( e )
      {
        setProviderError(e.message)
        console.log(`${e}: creating websocket for url: ${wsUrl}`);
        return
      }

      info.connection = connection
      
      connection.onopen = function() {
        setProviderStatus(`Connected to ${settings.url}`)
        app.debug('connected');

        if ( info.reconnectTimer ) {
          clearInterval(info.reconnectTimer)
          info.reconnectTimer = null;
        }

        /*
        if ( !settings.jwtToken || settings.jwtToken.length == 0 ) {
          let msg = JSON.stringify({
            requestId: uuidv4(),
            accessRequest: {
              clientId: uuidv4(),
              description: app.getSelfPath('name'),
              permissions: 'readwrite'
            }
          })
          debug('sending access request %s', msg)
          connection.send(msg)
        }*/

        if ( positionSubscription && settings.getOtherVessels ) {
          sendPosistionSubscription(info, positionSubscription)
        }

        var context = "vessels.self"

        /*
        if ( typeof options.sendOtherVessels !== 'undefined'
             && options.sendOtherVessels ) {
          context = "vessels.*"
        }*/

        var localSubscription

        if ( settings.dataToSend == 'all' ) {
          localSubscription = {
            "context": context,
            subscribe: [{
              path: "*",
              period: settings.serverUpdatePeriod * 1000
            }]
          }
        } else {
          localSubscription = {
            "context": context,
            subscribe: [{
              path: "navigation.*",
              period: settings.serverUpdatePeriod * 1000
            }]
          }
          
          if ( settings.dataToSend == 'nav+environment' ) {
            localSubscription.subscribe.push(
              {
                path: "environment.*",
                period: settings.serverUpdatePeriod * 1000
              }
            );
          }
        }

        /*
        if ( typeof options.sendOtherVessels !== 'undefined'
             && options.sendOtherVessels ) {
          otherVesselsPaths.forEach(p => {
            localSubscription.subscribe.push(
              {
                path: p,
                period: options.serverUpdatePeriod * 1000
              }
            );
          });
        }
        */
        
        app.debug("local subscription: " + JSON.stringify(localSubscription))

        app.subscriptionmanager.subscribe(localSubscription,
                                          info.onStop,
                                          subscription_error,
                                          delta => {
                                            handleDelta(info, delta)
                                          });

        /*
        if ( typeof options.sendOtherVessels !== 'undefined'
             && options.sendOtherVessels ) {
          localSubscription.context = "atons.*";
          app.subscriptionmanager.subscribe(localSubscription,
                                            onStop,
                                            subscription_error,
                                            handleDelta);
        }
        */
        

        sendStatic(info)
        info.staticTimer = setInterval(() => {
          sendStatic(info)
        }, 60000*settings.staticUpdatePeriod)

        /*
        if ( positionSubscription ) {
          var vesselsUrl = httpURL + `vessels?radius=${options.otherVesselsRadius}&latitude=${positionSubscription.latitude}&longitude=${positionSubscription.longitude}`;
          app.debug(`Getting existing vessels using ${vesselsUrl}`)
          request(vesselsUrl, (error, response, body) => {
            if ( !error && response.statusCode ) {
              var vessels = JSON.parse(body)
              _.forIn(vessels, (value, key) => {
                if ( ("vessels." + key) != selfContext ) {
                  app.debug(`loading vessel: ${key}`)
                  app.signalk.root.vessels[key] = value
                }
            });
            } else {
              console.log(`Error getting existing vessels from cloud server: ${error}`)
            }
          });
        }
        */
      }
      
      connection.onerror = function(error) {
        setProviderError(error.message)
        app.error('connection error: ' + settings.url);
        app.error(error.stack)
      }
      connection.onmessage = function(msg) {
        var delta = JSON.parse(msg.data)
        if(delta.updates && delta.context != selfContext ) {
          cleanupDelta(delta, true)
          //app.debug("got delta: " + msg.data)
          //app.signalk.addDelta.call(app.signalk, delta)
          app.handleMessage(plugin.id, delta)
        } else if ( delta.accessRequest ) {
          if ( delta.accessRequest.token ) {
            settings.jwtToken = delta.accessRequest.token
            info.hasToken = true
            debug('got token %s', settings.jwtToken)
            app.savePluginOptions(options, (err) => {})
          } else {
            let msg = 'access request was denied'
            setProviderError(msg)
            app.error(msg)
          }
        }
      };
      connection.onclose = function(event) {
        setProviderError(`connection closed: ${settings.url}`)
        app.debug('connection closed %s', settings.url);
        stopSubscription(settings.url)
        info.connection = null
        info.reconnectTimer = setInterval(() => {
          connect(settings)
        }, 10000)
      };
    });
  }

  plugin.stop = function() {
    _.keys(connectionInfos).forEach(url => {
      let info = connectionInfos[url]
      stopSubscription(url)
      if ( info.connection ) {
        debug('closing connection to %s', url)
        info.connection.onclose = null;
        info.connection.close();
      }
    })
    connectionInfos = {}
  };

  function stopSubscription(url)
  {
    let info = connectionInfos[url]
    info.onStop.forEach(f => f());
    info.onStop = []

    if ( info.staticTimer ) {
      clearInterval(info.staticTimer)
      info.staticTimer = null;
    }
    if ( info.reconnectTimer ) {
      clearInterval(info.reconnectTimer)
      info.reconnectTimer = null
    }
  }

  function subscription_error(err)
  {
    app.error("error: " + err)
  }

  function cleanupDelta(delta, fromCloud) {
    delta.updates.forEach(d => {

      if ( fromCloud ) {
        if ( typeof d.source !== 'undefined' ) {
          d.source.label = "cloud:" + d.source.label
        } else {
          d["$source"] = "cloud:" + d["$source"] 
        }
      }
    });
    //app.debug("cleanupDeltaFromCloud: " + JSON.stringify(delta))
  }

  function handleDelta (info, delta) {
    var isFromCloud = false

    if ( !info.hasToken ) {
      return
    }

    if ( delta.updates ) {
      delta.updates.forEach(u => {
        if ( (typeof u.source !== 'undefined'
              && typeof u.source.label !== 'undefined'
              && u.source.label.startsWith("cloud:"))
             || (typeof u["$source"] !== 'undefined'
                 && u["$source"].startsWith("cloud:")) ) {
          isFromCloud = true;
        }
      });
      
      if ( isFromCloud ) {
        //app.debug("skipping: " + JSON.stringify(delta))
        return
      }
      
      if (delta.context === 'vessels.self') {
        delta.context = selfContext
      }
      
      //cleanupDelta(delta, false)
      
      delta.updates.forEach(u => {
        if ( typeof u.source !== 'undefined' ) {
          delete u.source
        }
        if ( typeof u["$source"] !== 'undefined' ) {
          delete u["$source"]
        }

        if ( info.settings.getOtherVessels &&
             delta.context == selfContext &&
             !info.positionSubscriptionSent &&
             u.values ) {
          var pos =  u.values.find(pv => pv.path === 'navigation.position')
          if ( pos ) {
            sendPosistionSubscription(info, pos.value)
          }
        }
      });

      //app.debug("sendDelta: " + JSON.stringify(delta))

      
      info.connection.send(JSON.stringify(delta), function(error) {
        if ( typeof error !== 'undefined' ) {
          setProviderError(`sending: ${info.url} ${error.toString()}`)
          app.error(`error sending to server: ${info.url}`);
          app.error(error)
          hadError = true
        } else if ( hadError ) {
          setProviderStatus(`Connected to ${info.url}`)
          hadError = false
        }
      })
    }
  }

  function sendPosistionSubscription(info, position) {
    var remoteSubscription = {
      context: {
        radius: info.settings.otherVesselsRadius,
        position: position
      },
      subscribe: [{
        path: "*",
        period: info.settings.clientUpdatePeriod * 1000
      }]
    }
    
    app.debug("remote subscription: " + JSON.stringify(remoteSubscription))

    info.positionSubscriptionSent = true
          
    info.connection.send(JSON.stringify(remoteSubscription), function(error) {
      if ( typeof error !== 'undefined' ) {
        setProviderError(`sending: ${error.toString()}`)
        app.error("error sending to server: " + error);
        hadError = true
      } else if ( hadError ) {
        setProviderStatus(`Connected to ${info.settings.url}`)
        hadError = false
      }
    });
  }

  function sendStatic(info) {
    if ( !info.hasToken )
      return
    
    var values = [{
      path: "",
      value: {
        serverName: 'signalk-server-node',
        serverVersion: app.config.version
      }
    }];
    
    staticKeys.forEach(path => {
      var val = app.getSelfPath(path);
      if ( typeof val !== 'undefined' ) {
        if ( typeof val.value !== 'undefined' ) {
          val = val.value
        }
        if ( path.indexOf('.') == -1 ) {
          var nval = {}
          nval[path] = val
          values.push({ "path": "", value: nval})
        } else {
          values.push({"path": path, value: val})
        }
      }
    });
    var delta = {
      context: selfContext,
      updates: [ {"values": values} ]
    }
    var deltaString = JSON.stringify(delta)
    app.debug("sending static data: " + deltaString)
    info.connection.send(deltaString, function(error) {
      if ( typeof error !== 'undefined' ) {
        setProviderError(`sending: ${error.toString()}`)
        app.error("error sending to server: " + error);
        hadError = true
      } else if ( hadError ) {
        setProviderStatus(`Connected to ${info.settings.url}`)
        hadError = false
      }
    });
  }

  plugin.schema = {
    type: 'object',
    required: ['url'],
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Server Enabled',
        default: true
      },
      url: {
        type: 'string',
        title: 'Server URL',
        default: 'http://cloud.signalk.org'
      },
      jwtToken: {
        type: "string",
        title: "JWT Token"
      },
      serverUpdatePeriod: {
        type: 'number',
        description: "This is the rate at which updates will be sent to the server",
        title: 'Server Update Period (seconds)',
        default: 30
      },
      staticUpdatePeriod: {
        type: 'number',
        description: "This is the rate at which updates to static data (name, msi, deisgn, etc) will be sent to the server",
        title: 'Static Update Period (minutes)',
        default: 5
      },      
      dataToSend: {
        type: "string",
        title: "Data To Send",
        enum: [ "nav", "nav+environment", "all" ],
        enumNames: [ "Navigation related data only", "Navigation data and Environmental data", "All Data"],
        default: "nav+environment"
      },
      getOtherVessels: {
        type: 'boolean',
        title: 'Get Other Vessels',
        description: 'When enabled, other vessels in range will be subscribed to',
        default: false
      },
      clientUpdatePeriod: {
        type: 'number',
        description: "This is the rate at which updates received from the server",
        title: 'Client Update Period (seconds)',
        default: 30
      },
      otherVesselsRadius: {
        type: "number",
        description: "The radius in meters of other vessels to watch",
        title: "Other Vessel Radius",
        default: 5000
      },
      otherServers: {
        type: 'array',
        title: 'Other Servers',
        items: {
          type: 'object',
          required: ['url'],
          properties: {
            enabled: {
              type: 'boolean',
              title: 'Server Enabled',
              default: true
            },
            url: {
              type: 'string',
              title: 'Server URL',
              default: 'http://cloud.signalk.org'
            },
            jwtToken: {
              type: "string",
              title: "JWT Token"
            },
            serverUpdatePeriod: {
              type: 'number',
              description: "This is the rate at which updates will be sent to the server",
              title: 'Server Update Period (seconds)',
              default: 30
            },
            staticUpdatePeriod: {
              type: 'number',
              description: "This is the rate at which updates to static data (name, msi, deisgn, etc) will be sent to the server",
              title: 'Static Update Period (minutes)',
              default: 5
            },      
            dataToSend: {
              type: "string",
              title: "Data To Send",
              enum: [ "nav", "nav+environment", "all" ],
              enumNames: [ "Navigation related data only", "Navigation data and Environmental data", "All Data"],
              default: "nav+environment"
            },
            getOtherVessels: {
              type: 'boolean',
              title: 'Get Other Vessels',
              description: 'When enabled, other vessels in range will be subscribed to',
              default: false
            },
            clientUpdatePeriod: {
              type: 'number',
              description: "This is the rate at which updates received from the server",
              title: 'Client Update Period (seconds)',
              default: 30
            },
            otherVesselsRadius: {
              type: "number",
              description: "The radius in meters of other vessels to watch",
              title: "Other Vessel Radius",
              default: 5000
            }
          }
        }
      }
    }
  };

  return plugin;

};
