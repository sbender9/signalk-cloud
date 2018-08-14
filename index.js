const WebSocket = require('ws')
const _ = require('lodash')
const request = require('request')
const debug = require('debug')('signalk-cloud')

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
  var connection
  var onStop = []
  var options
  var staticTimer
  var reconnectTimer
  var positionSubscription
  let selfContext = 'vessels.' + app.selfId
  var statusMessage
  var hadError = false

  plugin.id = "signalk-cloud";
  plugin.name = "SignalK Cloud";
  plugin.description = "Plugin that updates and retrieves data from a SignalK cloud server";

  const setProviderStatus = app.setProviderStatus
        ? (msg, type) => {
          app.setProviderStatus(msg, type)
          statusMessage = `${type}: ${msg}`
        } : (msg, type) => { statusMessage = `${type}: ${msg}` }

  plugin.statusMessage = () => {
    return statusMessage
  }
  
  plugin.start = function(theOptions) {
    options = theOptions;

    if ( typeof options.jwtToken === 'undefined'
         || options.jwtToken.length == 0 )
    {
      setProviderStatus('no jwt token configured', 'error')
      console.log('signalk-cloud: ERROR no jwt token specified')
      return;
    }
    
    connect()
  };

  function connect()
  {
    var url

    //try to support old config which had the ws url
    if ( options.url.startsWith("ws:") ) {
      url = "http:" + options.url.substring(3);
    } else if ( options.url.startsWith("wss:") ) {
      url = "https:" + options.url.substring(4);
    } else {
      url = options.url
    }

    positionSubscription = app.getSelfPath("navigation.position")
    
    if ( !_.isUndefined(positionSubscription) && !_.isUndefined(positionSubscription.value) ) {
      positionSubscription = positionSubscription.value
    }

    if ( !_.isUndefined(positionSubscription) && (_.isUndefined(positionSubscription.latitude) || _.isUndefined(positionSubscription.longitude)) ) {
      positionSubscription = null
    }
    
    app.debug(`myposition: ${JSON.stringify(positionSubscription)}`)

    var infoUrl = url + '/signalk'
    app.debug(`trying ${infoUrl}`)
    request(infoUrl, function (error, response, body) {
      if ( error )
      {
        const msg = `Error connecting to cloud server ${error.message}`
        setProviderStatus(msg, 'error')
        app.error(msg)
        if ( ! reconnectTimer ) {
          reconnectTimer = setInterval(connect, 10000)
        }
        return
      } else if ( response.statusCode != 200 ) {
        const msg = `Bad status code from cloud server ${response.statusCode}`
        setProviderStatus(msg, 'error')
        app.error(msg)
        if ( !reconnectTimer ) {
          reconnectTimer = setInterval(connect, 10000)
        }
        return
      }

      var info = JSON.parse(body)

      app.debug(`server info ${JSON.stringify(info)}`)
      
      var endpoints = info.endpoints.v1
      
      var wsUrl = (endpoints['signalk-ws'] ? endpoints['signalk-ws'] : endpoints['signalk-wss']) + '?subscribe=none'
      var httpURL = (endpoints['signalk-https'] ? endpoints['signalk-https'] : endpoints['signalk-http'])

      if ( !httpURL.endsWith('/') ) {
        httpURL = httpURL + '/'
      }

      const msg = `trying to connect to: ${wsUrl}`
      setProviderStatus(msg, 'normal')
      app.debug(msg)

      var wsOptions = {}
      
      if ( typeof options.jwtToken !== 'undefined'
           && options.jwtToken.length > 0 ) {
        wsOptions.headers = { 'Authorization': 'JWT ' + options.jwtToken }
      }

      try
      {
        connection = new WebSocket(wsUrl, "ws", wsOptions);
      }
      catch ( e )
      {
        setProviderStatus(e.message, 'error')
        console.log(`${e}: creating websocket for url: ${wsUrl}`);
        return
      }

      connection.onopen = function() {
        setProviderStatus(`Connected to ${options.url}`, 'normal')
        app.debug('connected');

        if ( reconnectTimer ) {
          clearInterval(reconnectTimer)
          reconnectTimer = null;
        }

        if ( positionSubscription ) {
          sendPosistionSubscription(connection, positionSubscription)
        }

        var context = "vessels.self"

        /*
        if ( typeof options.sendOtherVessels !== 'undefined'
             && options.sendOtherVessels ) {
          context = "vessels.*"
        }*/

        var localSubscription

        if ( options.dataToSend == 'all' ) {
          localSubscription = {
            "context": context,
            subscribe: [{
              path: "*",
              period: options.serverUpdatePeriod * 1000
            }]
          }
        } else {
          localSubscription = {
            "context": context,
            subscribe: [{
              path: "navigation.*",
              period: options.serverUpdatePeriod * 1000
            }]
          }
          
          if ( options.dataToSend == 'nav+environment' ) {
            localSubscription.subscribe.push(
              {
                path: "environment.*",
                period: options.serverUpdatePeriod * 1000
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
                                          onStop,
                                          subscription_error,
                                          handleDelta);

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
        

        sendStatic()
        staticTimer = setInterval(sendStatic, 60000*options.staticUpdatePeriod)

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
        setProviderStatus(error.message, 'error')
        app.error('connection error:' + error);
      }
      connection.onmessage = function(msg) {
        var delta = JSON.parse(msg.data)
        if(delta.updates && delta.context != selfContext ) {
          cleanupDelta(delta, true)
          //app.debug("got delta: " + msg.data)
          //app.signalk.addDelta.call(app.signalk, delta)
          app.handleMessage(plugin.id, delta)
        }
      };
      connection.onclose = function(event) {
        setProviderStatus('connection closed', error)
        app.debug('connection close');
        stopSubscription()
        connection = null
        reconnectTimer = setInterval(connect, 10000)
      };
    });
  }

  plugin.stop = function() {
    stopSubscription()
    if ( connection )
    {
      connection.onclose = null;
      connection.close();
    }
  };

  function stopSubscription()
  {
    onStop.forEach(f => f());
    onStop = []

    if ( staticTimer ) {
      clearInterval(staticTimer)
      staticTimer = null;
    }
    if ( reconnectTimer ) {
      clearInterval(reconnectTimer)
      reconnectTimer = null
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

  function handleDelta (delta) {
    var isFromCloud = false

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

        if ( delta.context == selfContext &&
             !positionSubscription &&
             u.values ) {
          var pos =  u.values.find(pv => pv.path === 'navigation.position')
          if ( pos ) {
            sendPosistionSubscription(connection, pos.value)
            positionSubscription = pos.value
          }
        }
      });

      //app.debug("sendDelta: " + JSON.stringify(delta))

      
      connection.send(JSON.stringify(delta), function(error) {
        if ( typeof error !== 'undefined' ) {
          setProviderStatus(`sending: ${error.toString()}`, 'error')
          app.error("error sending to server: " + error);
          hadError = true
        } else if ( hadError ) {
          setProviderStatus(`Connected to ${options.url}`, 'normal')
          hadError = false
        }
      })
    }
  }

  function sendPosistionSubscription(connection, position) {
    var remoteSubscription = {
      context: {
        radius: options.otherVesselsRadius,
        position: position
      },
      subscribe: [{
        path: "*",
        period: options.clientUpdatePeriod * 1000
      }]
    }
    
    app.debug("remote subscription: " + JSON.stringify(remoteSubscription))
          
    connection.send(JSON.stringify(remoteSubscription), function(error) {
      if ( typeof error !== 'undefined' ) {
        setProviderStatus(`sending: ${error.toString()}`, 'error')
        app.error("error sending to server: " + error);
        hadError = true
      } else if ( hadError ) {
        setProviderStatus(`Connected to ${options.url}`, 'normal')
        hadError = false
      }
    });
  }

  function sendStatic() {
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
    connection.send(deltaString, function(error) {
      if ( typeof error !== 'undefined' ) {
        setProviderStatus(`sending: ${error.toString()}`, 'error')
        app.error("error sending to server: " + error);
        hadError = true
      } else if ( hadError ) {
        setProviderStatus(`Connected to ${options.url}`, 'normal')
        hadError = false
      }
    });
  }

  plugin.schema = {
    type: 'object',
    required: ['url'],
    properties: {
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
      /*
      sendOtherVessels: {
        type: "boolean",
        title: "Send Data For Other Vessels",
        description: "If enabled, you will send data from your AIS to cloud also",
        default: false
      },
      */
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
  };

  return plugin;

};
