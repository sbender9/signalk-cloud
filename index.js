const debug = require("debug")("signalk:cloud");
const util = require("util");
const WebSocket = require('ws')
const _ = require('lodash')
const geolib = require('geolib')
const request = require('request')

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
  var positionTimer
  var lastSubscriptionPosition
  let selfContext = 'vessels.' + app.selfId

  plugin.id = "signalk-cloud";
  plugin.name = "SignalK Cloud";
  plugin.description = "Plugin that updates and retrieves data from a SignalK cloud server";

  plugin.start = function(theOptions) {
    debug("start");

    options = theOptions;

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

    request(url + '/signalk', function (error, response, body) {
      if ( error )
      {
        console.log(`Error connecting to cloud server ${error}`)
        reconnectTimer = setInterval(connect, 10000)
        return
      } else if ( response.statusCode != 200 ) {
        console.log(`Bad status code from cloud server ${response.statusCode}`)
        reconnectTimer = setInterval(connect, 10000)
        return
      }

      var info = JSON.parse(body)

      debug(`server info ${JSON.stringify(info)}`)
      
      var endpoints = info.endpoints.v1
      
      var wsUrl = (endpoints['signalk-ws'] ? endpoints['signalk-ws'] : endpoints['signalk-wss']) + '?subscribe=none'
      var httpURL = (endpoints['signalk-https'] ? endpoints['signalk-https'] : endpoints['signalk-http'])

      if ( !httpURL.endsWith('/') ) {
        httpURL = httpURL + '/'
      }

      
      debug("trying to connect to: " + wsUrl)

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
        console.log(`${e}: creating websocket for url: ${theUrl}`);
        return
      }

      connection.onopen = function() {
        debug('connected');

        if ( reconnectTimer ) {
          clearInterval(reconnectTimer)
          reconnectTimer = null;
        }

        var myposition = _.get(app.signalk.self, "navigation.position")

        if ( typeof myposition === 'undefined'
             || typeof myposition.value === 'undefined'
             || typeof myposition.value.latitude === 'undefined'
             || typeof myposition.value.longitude === 'undefined' )
        {
          debug("no position, retying in 10s...")
          reconnectTimer = setInterval(connect, 10000)
          return
        }

        debug(`myposition: ${JSON.stringify(myposition)}`)

        var remoteSubscription = {
          context: {
            relativePosition: {
              radius: options.otherVesselsRadius,
              latitude: myposition.value.latitude,
              longitude: myposition.value.longitude
            }
          },
          subscribe: [{
            path: "*",
            period: options.clientUpdatePeriod * 1000
          }]
        }

        debug("remote subscription: " + JSON.stringify(remoteSubscription))
        
        connection.send(JSON.stringify(remoteSubscription), function(error) {
          if ( typeof error !== 'undefined' )
            console.log("error sending to serveri: " + error);
        });

        lastSubscriptionPosition = myposition.value
        
        var context = "vessels.self"

        if ( typeof options.sendOtherVessels !== 'undefined'
             && options.sendOtherVessels ) {
          context = "vessels.*"
        }

        var localSubscription = {
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
        
        debug("local subscription: " + JSON.stringify(localSubscription))
        
        app.subscriptionmanager.subscribe(localSubscription,
                                          onStop,
                                          subscription_error,
                                          handleDelta);

        if ( typeof options.sendOtherVessels !== 'undefined'
             && options.sendOtherVessels ) {
          localSubscription.context = "atons.*";
          app.subscriptionmanager.subscribe(localSubscription,
                                            onStop,
                                            subscription_error,
                                            handleDelta);
        }
        

        sendStatic()
        staticTimer = setInterval(sendStatic, 60000*options.staticUpdatePeriod)

        positionTimer = setInterval(checkPosition, 60000)

        var vesselsUrl = httpURL + `vessels?radius=${options.otherVesselsRadius}&latitude=${myposition.value.latitude}&longitude=${myposition.value.longitude}`;
        debug(`Getting existing vessels using ${vesselsUrl}`)
        request(vesselsUrl, (error, response, body) => {
          if ( !error && response.statusCode ) {
            var vessels = JSON.parse(body)
            _.forIn(vessels, (value, key) => {
              if ( key != selfContext ) {
                debug(`loading vessel: ${key}`)
                app.signalk.root.vessels[key] = value
              }
            });
          } else {
            console.log(`Error getting existing vessels from cloud server: ${error}`)
          }
        });
      }
      
      connection.onerror = function(error) {
        debug('error:' + error);
      }
      connection.onmessage = function(msg) {
        var delta = JSON.parse(msg.data)
        if(delta.updates && delta.context != selfContext ) {
          cleanupDelta(delta, true)
          //debug("got delta: " + msg.data)
          app.signalk.addDelta.call(app.signalk, delta)
        }
      };
      connection.onclose = function(event) {
        debug('connection close');
        stopSubscription()
        connection = null
        reconnectTimer = setInterval(connect, 10000)
      };
    });
  }

  plugin.stop = function() {
    debug("stopping...")
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
    if ( positionTimer ) {
      clearInterval(positionTimer)
      positionTimer = null;
    }
  }

  function subscription_error(err)
  {
    console.log("error: " + err)
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
    //debug("cleanupDeltaFromCloud: " + JSON.stringify(delta))
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
      //debug("skipping: " + JSON.stringify(delta))
        return
      }
      
      if (delta.context === 'vessels.self') {
        delta.context = selfContext
      }
      
      //debug("handleDelta: " + delta.context)
      
      //cleanupDelta(delta, false)
      
      delta.updates.forEach(u => {
        if ( typeof u.source !== 'undefined' ) {
          delete u.source
        }
        if ( typeof u["$source"] !== 'undefined' ) {
          delete u["$source"]
        }
      });

      
      connection.send(JSON.stringify(delta), function(error) {
        if ( typeof error !== 'undefined' )
          console.log("error sending to serveri: " + error);
      })
    }
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
      var val = _.get(app.signalk.self, path)
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
    debug("sending static data: " + deltaString)
    connection.send(deltaString, function(error) {
      if ( typeof error !== 'undefined' )
        console.log("error sending to serveri: " + error);
    });
  }

  function checkPosition() {
    var pos = _.get(app.signalk.self, "navigation.position")
    var dist = geolib.getDistance(lastSubscriptionPosition, pos.value)
    debug(`checkPosition: ${dist}`)
    if ( dist > 2000 ) {
      stopSubscription()
      if ( connection )
      {
        connection.onclose = null;
        connection.close();
      }
      connect()
    }
  }

  plugin.schema = {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        title: 'Server URL',
        default: 'http://cloud.wilhelmsk.com'
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
        enum: [ "nav", "nav+environment" ],
        enumNames: [ "Navigation related data only", "Navigation data and Environmental data"],
        default: "nav+environment"
      },
      sendOtherVessels: {
        type: "boolean",
        title: "Send Data For Other Vessels",
        description: "If enabled, you will send data from your AIS to cloud also",
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
  };

  return plugin;

};
