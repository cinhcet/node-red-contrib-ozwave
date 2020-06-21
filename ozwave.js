module.exports = function(RED) {
  "use strict";

  const OpenZWave = require('openzwave-shared');
  const path = require('path');
  const fs = require('fs');

  // The underlying lib openzwave-shared only allows a single instance.
  // Since opening openzwave takes a long time, only do that ones and not 
  // on every deploy.
  var zwave = {
    driver: null,
    connected: false,
    isConnecting: false,
    homeId: null,
    devices: new Map()
  };

  var numberOfConfigNodes = 0;

  function ozwaveConfig(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.config = config;
  
    numberOfConfigNodes++;
    if(numberOfConfigNodes > 1) {
      node.error('Only a single zwave config node is possible, due to limitations of the underlying library');
      numberOfConfigNodes--;
      return;
    }

    node.zwave = zwave;

    node.deviceEventCallbacks = new Map();
    node.controllerEventCallbacks = new Map();

    // create zwave instance if it does not exist
    if(node.zwave.driver === null) {
      let ozwavePath = path.join(RED.settings.userDir, 'ozwave');
      if(!fs.existsSync(ozwavePath)) {
        fs.mkdirSync(ozwavePath);
      }

      node.zwave.driver = new OpenZWave({
        Logging: false,
        ConsoleOutput: false,
        UserPath: ozwavePath,
        DriverMaxAttempts: 5,
        NetworkKey: node.config.networkKey
      });
    }

    function callControllerCallback(event, value, optionalDeviceId) {
      for(let callback of node.controllerEventCallbacks.values()) {
        callback(event, value, optionalDeviceId);
      }
    }

    function callDeviceCallback(deviceId, event, value) {
      let deviceIdMap = node.deviceEventCallbacks.get(deviceId);
      if(deviceIdMap) {
        for(let callback of deviceIdMap.values()) {
          callback(event, value);
        }
      }
      callControllerCallback(event, value, deviceId);
    }

    node.zwave.driver.on('driver ready', function(homeId) {
      node.zwave.homeId = homeId;
      node.zwave.connected = true;
      node.zwave.isConnecting = false;
      callControllerCallback('driverReady');
    });
  
    node.zwave.driver.on('driver failed', function() {
      node.error('failed to start openzwave driver');
      node.zwave.connected = false;
      callControllerCallback('driverFailed');
      //node.zwave.driver.disconnect(node.config.port); // causes segfault, although taken from example
    });

    node.zwave.driver.on('node added', function(deviceId) {
      node.zwave.devices.set(deviceId, {
        cmdClasses: {},
        deviceId: deviceId,
        canBeUsed: false,
        state: 'added'
      });
      console.log('node added', deviceId);
    });

    node.zwave.driver.on('node naming', function(deviceId, device) {
      let temp = node.zwave.devices.get(deviceId);
      if(!temp) {
        node.error('device ' + deviceId + ' not available');
        return;
      }
      temp['manufacturer'] = device.manufacturer;
      temp['manufacturerid'] = device.manufacturerid;
      temp['product'] = device.product;
      temp['producttype'] = device.producttype;
      temp['productid'] = device.productid;
      temp['type'] = device.type;
      temp['name'] = device.name;
      temp['loc'] = device.loc;

      console.log('node naming', deviceId);
    });

    node.zwave.driver.on('node available', function(deviceId) {
      let temp = node.zwave.devices.get(deviceId);
      if(!temp) {
        node.error('device ' + deviceId + ' not available');
        return;
      }
      temp['listeningDevice'] = node.zwave.driver.isNodeListeningDevice(deviceId);
      temp['frequentListeningDevice'] = node.zwave.driver.isNodeFrequentListeningDevice(deviceId);
      console.log(deviceId, 'available and listening', temp['listeningDevice']);
    });

    node.zwave.driver.on('node ready', function(deviceId, device) {
      let temp = node.zwave.devices.get(deviceId);
      if(!temp) {
        node.error('device ' + deviceId + ' not available');
        return;
      }
      temp.canBeUsed = true;
      temp.state = 'alive';
      callDeviceCallback(deviceId, 'nodeReady', true);
      console.log('node ready', deviceId);
    });
  

    node.zwave.driver.on('node removed', function(deviceId) {
      let temp = node.zwave.devices.get(deviceId);
      if(!temp) {
        node.error('device ' + deviceId + ' not available');
        return;
      }
      temp.canBeUsed = false;
      temp.state = 'removed';
      console.log('removed', deviceId);
      node.zwave.devices.delete(deviceId);
      callDeviceCallback(deviceId, 'nodeRemoved', true);
    });

    node.zwave.driver.on('value added', function(deviceId, cmdClass, value) {
      let device = node.zwave.devices.get(deviceId);
      if(!device) {
        node.error('device ' + deviceId + ' not available');
        return;
      }
      if(!device.cmdClasses[cmdClass]) device.cmdClasses[cmdClass] = {};
      if(!device.cmdClasses[cmdClass][value.instance]) device.cmdClasses[cmdClass][value.instance] = {};
      device.cmdClasses[cmdClass][value.instance][value.index] = value;
      console.log('value added', deviceId, cmdClass);
    });

    node.zwave.driver.on('value removed', function(deviceId, cmdClass, instance, index) {
      let device = node.zwave.devices.get(deviceId);
      if(!device) {
        node.error('device ' + deviceId + ' not available');
        return;
      }
      if(device['cmdClasses'] &&
         device['cmdClasses'][cmdClass] &&
         device['cmdClasses'][cmdClass][instance] &&
         device['cmdClasses'][cmdClass][instance][index]
        ) {
        delete device['cmdClasses'][cmdClass][instance][index];
      }
    });
  
    node.zwave.driver.on('value changed', function(deviceId, cmdClass, value) {
      let device = node.zwave.devices.get(deviceId);
      if(!device) {
        node.error('device ' + deviceId + ' not found');
      } else {
        if(device['cmdClasses'] &&
           device['cmdClasses'][cmdClass] &&
           device['cmdClasses'][cmdClass][value.instance] &&
           device['cmdClasses'][cmdClass][value.instance][value.index]
          ) {
          let tmp = device['cmdClasses'][cmdClass][value.instance];
          value.oldValue = tmp[value.index].value;
          tmp[value.index] = value;
        } else {
          node.error('value for device ' + deviceId + ' changed, but cmdClass not found');
        }
      }

      // we call the callback always
      callDeviceCallback(deviceId, 'valueChanged', value);
    });

    node.zwave.driver.on('scene event', function(deviceId, sceneId) {
      callDeviceCallback(deviceId, 'sceneEvent', sceneId);
    });

    node.zwave.driver.on('notification', function(deviceId, notification, help) {
      let device = node.zwave.devices.get(deviceId);
      if(!device) {
        node.error('device ' + deviceId + ' not found');
      } else {
        if(notification === 3) {
          //awake
          device.canBeUsed = true;
          device.state = 'awake';
        } else if(notification === 4) {
          //sleep
          if(!device.isNodeListeningDevice) {
            //only if the device is sleeping and a battery device
            device.canBeUsed = true;
          } else {
            device.canBeUsed = false;
          }
          device.state = 'sleep';
        } else if(notification === 5) {
          //dead
          device.canBeUsed = false;
          device.state = 'dead';
        } else if(notification === 6) {
          //alive
          device.canBeUsed = true;
          device.state = 'alive';
        }
      }
      callDeviceCallback(deviceId, 'notification', {notification: notification, help: help});
      console.log('notification', deviceId, help);
    });

    node.zwave.driver.on('controller command', function(deviceId, ctrlState, ctrlError, helpMsg) {
      callControllerCallback('controllerCommand', {
        deviceId: deviceId,
        ctrlState: ctrlState,
        ctrlError: ctrlError,
        helpMsg: helpMsg
      });
    });

    
    if(!node.zwave.connected && !node.zwave.isConnecting) {
      node.zwave.isConnecting = true;
      node.zwave.driver.connect(node.config.port);
    }
    
    node.on('close', function(removed, done) { 
      numberOfConfigNodes--;
      if(node.zwave.driver) node.zwave.driver.removeAllListeners();
      if(removed && node.zwave.connected) {
        console.log('openzwave instance removed!!!!!!!!!!!!!!!!!!!');
        try {
          node.zwave.driver.disconnect(node.config.port);
          node.zwave.driver = null;
          node.zwave.connected = false;
          node.zwave.homeId = null;
          node.zwave.devices.clear();
          
        } catch(e) {
          node.error('failed to disconnect openzwave', e);
        }
      }
      done();
    });
  }

  ozwaveConfig.prototype.subscribeDeviceId = function(deviceId, ozwaveDeviceNode, callback) {
    if(!this.deviceEventCallbacks.has(deviceId)) {
      let map = new Map();
      map.set(ozwaveDeviceNode, callback);
      this.deviceEventCallbacks.set(deviceId, map);
    } else {
      this.deviceEventCallbacks.get(deviceId).set(ozwaveDeviceNode, callback);
    }
    console.log('subscribed', deviceId);
  }

  ozwaveConfig.prototype.unsubscribeDeviceId = function(deviceId, ozwaveDeviceNode) {
    console.log('unsubscribe');
    let deviceIdMap = this.deviceEventCallbacks.get(deviceId);
    if(deviceIdMap) {
      deviceIdMap.delete(ozwaveDeviceNode);
    }
  }

  ozwaveConfig.prototype.subscribeController = function(ozwaveControllerNode, callback) {
    this.controllerEventCallbacks.set(ozwaveControllerNode, callback);
  }

  ozwaveConfig.prototype.unsubscribeController = function(ozwaveControllerNode) {
    this.controllerEventCallbacks.delete(ozwaveControllerNode);
  }

  RED.nodes.registerType("ozwave config", ozwaveConfig);



  /////////////////////////////////////////////////////////////////////////////


  function ozwaveControllerNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.config = config;
    node.deviceId = Number(node.config.deviceId);
    node.ozwaveController = RED.nodes.getNode(config.ozwaveController);

    node.status({fill: "red", shape: "ring", text:"not ready"});
    if(node.ozwaveController.zwave.connected) {
      node.status({fill: "green", shape:"dot", text:"ready"});
    }
    
    node.ozwaveController.subscribeController(node, function(event, value, optionalDeviceId) {
      if(event === 'driverReady') {
        node.status({fill: "green", shape:"dot", text:"ready"});
      } else if(event === 'driverFailed') {
        node.status({fill: "red", shape: "ring", text:"failed"});
      }
      node.send({
        event: event,
        payload: value,
        deviceId: optionalDeviceId
      });
    });

    node.on('input', function(m, send, done) {
      done();
    });

    node.on('close', function(removed, done) {
      node.ozwaveController.unsubscribeController(node);
      done();
    });
  }
  RED.nodes.registerType("ozwave controller", ozwaveControllerNode);



  /////////////////////////////////////////////////////////////////////////////


  function setStatusDevice(node) {
    let device = node.ozwaveController.zwave.devices.get(node.deviceId);
    if(device) {
      if(device.state === 'awake') {
        node.status({fill: "green", shape:"ring", text:"awake"});
      } else if(device.state === 'sleep') {
        node.status({fill: "yellow", shape:"dot", text:"sleep"});
      } else if(device.state === 'dead') {
        node.status({fill: "red", shape:"dot", text:"dead"});
      } else if(device.state === 'alive') {
        node.status({fill: "green", shape: "dot", text: "alive"});
      }
    } else {
      node.status({fill: "red", shape: "ring", text: "not found"});
    }
  }

  function ozwaveDevice(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.config = config;
    node.deviceId = Number(node.config.deviceId);
    node.ozwaveController = RED.nodes.getNode(config.ozwaveController);

    node.status({fill: "red", shape: "ring", text: "not found"});
    setStatusDevice(node);

    node.ozwaveController.subscribeDeviceId(node.deviceId, node, function(event, value) {
      if(event === 'valueChanged') {
        let msg = {};
        msg.payload = value;
        msg.deviceId = node.deviceId;
        msg.event = event;
        node.send(msg);
      } else if(event === 'sceneEvent') {
        let msg = {
          payload: {sceneId: value},
          deviceId: node.deviceId,
          event: event
        };
        node.send(msg);
      } else if(event === 'notification') {
        setStatusDevice(node);
      } else if(event === 'nodeReady') {
        setStatusDevice(node);
      } else if(event === 'nodeRemoved') {
        node.status({fill: "red", shape: "ring", text: "removed"});
      }
    });

    node.on('input', function(m, send, done) {
      if(typeof m.payload === 'object' && typeof m.payload.cmd === 'string') {
        if(node.ozwaveController.zwave.connected) {
          // TODO add try catch everywhere
          if(m.payload.cmd == 'requestState') {
            node.ozwaveController.zwave.driver.requestNodeState(node.deviceId);
          } else if(m.payload.cmd == 'switchOn') {
            node.ozwaveController.zwave.driver.setValue(node.deviceId, 37, 1, 0, true);
          } else if(m.payload.cmd == 'switchOff') {
            node.ozwaveController.zwave.driver.setValue(node.deviceId, 37, 1, 0, false);
          } else if(m.payload.cmd == 'setValue') {
            if(m.payload.hasOwnProperty('deviceId') &&
               m.payload.hasOwnProperty('cmdClass') &&
               m.payload.hasOwnProperty('instance') &&
               m.payload.hasOwnProperty('index') &&
               m.payload.hasOwnProperty('value')
            ) {
              node.ozwaveController.zwave.driver.setValue(m.payload.deviceId, 
                                                          m.payload.cmdClass, 
                                                          m.payload.instance, 
                                                          m.payload.index,
                                                          m.payload.value);
            } else {
              node.warn('wrong payload');
            }
          } else {
            done('unknown command');
            return;
          }
        }
        // TODO add else case
        done();
      } else {
        done('message malformed', m);
      }
    });

    node.on('close', function(removed, done) {
      if(node.ozwaveController) {
        node.ozwaveController.unsubscribeDeviceId(node.deviceId, node);
      }
      done();
    });
  }
  RED.nodes.registerType("ozwave device", ozwaveDevice);



  /////////////////////////////////////////////////////////////////////////////


  RED.httpAdmin.get("/ozwave/getDevice", RED.auth.needsPermission('ozwave.read'), function(req, res) {
    if(req.query.hasOwnProperty('deviceId')) {
      let device = zwave.devices.get(Number(req.query.deviceId));
      if(device) {
        res.json(device);
      } else {
        res.json({notFound: true});
      }
    }
  });

  RED.httpAdmin.get("/ozwave/getAllDevices", RED.auth.needsPermission('ozwave.read'), function(req, res) {
    let list = [];
    zwave.devices.forEach(function(device) {
      let label = device.deviceId + ': ';
      if(device.name) label += device.name + ' ';
      if(device.loc) label += 'at ' + device.loc + '. ';
      label += device.product + ' from ' + device.manufacturer;
      list.push({
        label: label,
        value: device.deviceId
      });
    });
    res.json(list);
  });

  RED.httpAdmin.post("/ozwave/setDeviceConfig", RED.auth.needsPermission('ozwave.write'), function(req, res) {
    console.log(req.body);
    if(req.body.hasOwnProperty('deviceId')) {
      let device = zwave.devices.get(Number(req.body.deviceId));
      if(device) {
        if(req.body.hasOwnProperty('action')) {
          if(req.body.action === 'setDeviceName' && typeof req.body.params === 'string') {
            zwave.driver.setNodeName(device.deviceId, req.body.params);
          } else if(req.body.action === 'setDeviceLocation' && typeof req.body.params === 'string') {
            zwave.driver.setNodeLocation(device.deviceId, req.body.params);
          }
        }
      }
    }
    res.sendStatus(200);
  });

  RED.httpAdmin.post("/ozwave/setControllerCommand", RED.auth.needsPermission('ozwave.write'), function(req, res) {
    console.log(req.body);
    if(req.body.hasOwnProperty('action')) {
      if(req.body.action === 'addDevice') {
        zwave.driver.addNode(false);
      } else if(req.body.action === 'addDeviceSecure') {
        zwave.driver.addNode(true);
      } else if(req.body.action === 'removeDevice') {
        zwave.driver.removeNode();
      } else if(req.body.action === 'cancelCommand') {
        zwave.driver.cancelControllerCommand(); 
      }
    }
    res.sendStatus(200);
  });

}
