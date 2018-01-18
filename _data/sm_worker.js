"use strict";

var stateMachineDataFileName = "state_machine_data.sm_data"
var stateMachineUpdateDataFileName = "state_machine_data.sm_data.preview"

// Synchronous read (only for use in workers)
var readJSON = function( fileName )
{
    var xhr = new XMLHttpRequest();
    xhr.open("GET", fileName, false);  // synchronous request
    xhr.send(null);
    xhr.responseText;
    return JSON.parse( xhr.responseText );
}
var readFile = function( fileName )
{
    var xhr = new XMLHttpRequest();
    xhr.open("GET", fileName, false);  // synchronous request
    xhr.send(null);
    xhr.responseText;
    return xhr.responseText;
}
function httpGetAsync(theUrl, callback)
{
    var xmlHttp = new XMLHttpRequest();
    xmlHttp.onreadystatechange = function() { 
        if (xmlHttp.readyState == 4 && xmlHttp.status == 200)
            callback(xmlHttp.responseText);
    }
    xmlHttp.open("GET", theUrl, true); // true for asynchronous 
    xmlHttp.send(null);
}
var getFileData = function( fileName, func )
{
    var xhr = new XMLHttpRequest();
    xhr.open("HEAD", fileName, true);  // asynchronous request
    xhr.setRequestHeader("Cache-Control", "no-cache"); // We want the fresh data always
    var localFunc = function(){
        func(xhr);
    };
    xhr.onreadystatechange = localFunc;
    xhr.send(null);
}

var smRunnerClient = {
    userPtr: 0,
    onList: {},
    publish: function(topic, value)
    {
        var handled = false;
        if (glsEditorSupport)
        {
            handled = glsEditorSupport.HandleSpecialOutgoing( topic, value );
        }
        if (!handled)
        {
            self.postMessage({cmd:"publish", topic: topic, value: value, userPtr: this.userPtr});
        }
    },
    subscribe: function(topic, value)
    {
        self.postMessage({cmd:"subscribe", topic: topic, userPtr: this.userPtr});
    },
    on: function(when, func)
    {
        if (!(when in this.onList))
        {
            this.onList[when] = []
        }
        this.onList[when].push( func )
    },
    
    // Possible Improvement: Make these functions generic with variable arguments
    fireOnMessage: function(topic, message, packet)
    {
        var when = 'message'
        if (!when in this.onList)
        {
            return;
        }
        var listeners = this.onList[when];
        for (var e in listeners)
        {
            listeners[e](topic, message, packet)
        }        
    },
    fireOnConnect: function()
    {
        var when = 'connect'
        if (!when in this.onList)
        {
            return;
        }
        var listeners = this.onList[when];
        for (var e in listeners)
        {
            listeners[e]()
        }        
    },
}

var preProcessedCodeById = readJSON( stateMachineDataFileName )

var window = self;
var global = {};

var state;
var client = smRunnerClient;
{
    var module={}
    importScripts('state.com.js')
    state = module.exports
}

var blockToCode = { getDefinitionFromBlockText: function(text){ console.log("getDefinitionFromBlockText not supported in this mode!!!!!!!!!"); } };

importScripts('disti_state_machine_impl.js')

importScripts('server.js')

importScripts('sm_gls_editor_support.js')

glsEditorSupport.Connect( "/state_machine_interface/live_gls_data/get_statemachine_runtime_editor_connection/", httpGetAsync, WebSocket )

// This is to listen to events coming from the target executable.  These have nothing to do with the GL Studio Editor environment.
self.addEventListener('message', function(e) {
    var data = e.data;
    //self.postMessage({cmd:"print_json_message", msg:data})
    switch (data.cmd) {    
        case 'publish':
          // We receive the publish from outside and handle it.
          if (!glsEditorSupport.HandleSpecialIncoming(data.topic, data.value))
          {
            smRunnerClient.fireOnMessage (data.topic, data.value, 0)
          }
          break;
        case 'subscribe':
          // PORTING INFO: If we really need to handle subscriptions, do it here.
          break;      
        case 'connect':
          // We receive the publish from outside and handle it.
          smRunnerClient.fireOnConnect ()
          smRunnerClient.userPtr = data.userPtr
          
          // Report back that we are now connected
          self.postMessage( { cmd:"connected", topic: "", value: "", userPtr: this.userPtr } )                         
          
          break;
        case 'stop':
          self.close(); // Terminates the worker.
          break;
        default:
          self.postMessage('Unknown command: ' + data.msg);
    };
}, false);


glsEditorSupport.onDataName("state_machine_update", function( data )
{
    if ("javascript" == data.form)
    {
        smRunnerClient.fireOnMessage("StateMachineSystem/PreProcessedDefines/javascript", data.value, 0);    
        console.log("Applied preview");
    }
    else
    {
        console.log("state_machine_update for form: "+data.form+" not supported.");
    }
});

glsEditorSupport.onDataName("set_dev_mode", function( data )
{
    if ("1" == data.value)
    {
        console.log("Turning dev mode on");
    }
    else
    {
        console.log("Turning dev mode off");
    }
    smRunnerClient.publish("StateMachineSystem/DevModeOn", data.value);    
        
});
