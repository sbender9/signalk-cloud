const debug = require("debug")("signalk:cloud");
const util = require("util");
const WebSocket = require('ws')
const url = require('url')
const _ = require('lodash')

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
  "design.rigging"
];
  

module.exports = function(app) {
  var plugin = {};
  var connection
  var blackList
  var onStop = []
  var options
  var staticTimer
  let selfContext = 'vessels.' + app.selfId

  plugin.id = "signalk-cloud";
  plugin.name = "SignalK Cloud";
  plugin.description = "Plugin that updates and retrieves data from a SignalK cloud server";

  plugin.start = function(theOptions) {
    debug("start");

    options = theOptions;

    connect()
    
    //app.signalk.on('delta', handleDelta)
  };

  function connect()
  {
    var wsUrl = {
      protocol: "ws",
      slashes: true,
      hostname: options.host,
      port: options.port,
      pathname: '/signalk/v1/stream',
      query: {'subscribe': "all"}
    };

    var theUrl = url.format(wsUrl)
    debug("trying to connecto to:: " + theUrl)

    var wsOptions = {}
    
    if ( typeof options.jwtToken !== 'undefined'
         && options.jwtToken.length > 0 ) {
      wsOptions.headers = { 'Authorization': 'JWT ' + options.jwtToken }
    }
    
    connection = new WebSocket(theUrl, "ws", wsOptions);
    /*
      skConnection.send = function(data) {
      connection.send(typeof data != 'string' ? JSON.stringify(data) : data);
      };
      skConnection.disconnect = function() {
      connection.close();
      debug('Disconnected');
    };
    */
    connection.onopen = function() {
      debug('connected');

      var command;

      /*
      command = {
        context: "vessels.*",
        subscribe: [{
          path: "*",
          period: options.clientUpdatePeriod * 1000
        }]
      }
      connection.send(JSON.stringify(command), function(error) {
        if ( typeof error !== 'undefined' )
          console.log("error sending to serveri: " + error);
      });
      */

      command = {
        context: "vessels.self",
        subscribe: [{
          path: "navigation.*",
          period: options.serverUpdatePeriod * 1000
        }]
      }

      if ( options.dataToSend == 'nav+environment' ) {
        command.subscribe.push({ path: "environment.*",
                                 period: options.resolution});
      }
      
      debug("subscription: " + JSON.stringify(command))
      
      app.subscriptionmanager.subscribe(command,
                                        onStop,
                                        subscription_error,
                                        handleDelta);

      sendStatic()
      staticTimer = setTimeout(sendStatic, 60000*options.staticUpdatePeriod)
    };
    connection.onerror = function(error) {
      debug('error:' + error);
    }
    connection.onmessage = function(msg) {
      var delta = JSON.parse(msg.data)
      if(delta.updates && delta.context != selfContext ) {
        //debug("got delta: " + msg.data)
        app.signalk.addDelta.call(app.signalk, delta)
      }
    };
    connection.onclose = function(event) {
      debug('connection close:' + event);
      stopSubscription()
      connection = null
      setTimeout(connect, 10000)
    };
  }

  plugin.stop = function() {
    //app.signalk.removeListener('delta', handleDelta)
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
      clearTimeout(staticTimer)
      staticTimer = null;
    }
  }

  function subscription_error(err)
  {
    console.log("error: " + err)
  }

  function handleDelta (delta) {
    //debug("handleDelta: " + delta)
    if (delta.context === 'vessels.self') {
      delta.context = selfContext
    }

    if (delta.updates && delta.context === selfContext) {
      connection.send(JSON.stringify(delta), function(error) {
        if ( typeof error !== 'undefined' )
          console.log("error sending to serveri: " + error);
      })
    }
  }

  function sendStatic() {
    var values = [];
    
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

  plugin.schema = {
    type: 'object',
    required: ['host', 'port'],
    properties: {
      host: {
        type: 'string',
        title: 'Host',
        default: 'localhost'
      },
      port: {
        type: 'number',
        title: 'Port',
        default: 3000
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
      clientUpdatePeriod: {
        type: 'number',
        description: "This is the rate at which updates received from the server",
        title: 'Client Update Period (seconds)',
        default: 30
      }
    }
  };

  return plugin;

};
