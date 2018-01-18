"use strict";

var glsEditorSupport;

(function(){
    glsEditorSupport = { 
        connection: null,
        websocket: null,
        connectionClosed: false,
        messagesQueued: [],
        cachedData: {}, // Used to get late-comers up to speed with rarely changing data
        Connect: function( urlArg, httpGetAsync, WebSocket)
        {
            httpGetAsync(urlArg, 
                function( port ) {   
                    var w = glsEditorSupport.websocket = new WebSocket( 'ws://127.0.0.1:' + port + '/runtime_reflector?id=sm_gls_editor_support&last_will_message=[{"name":"ActiveBlockData", "value":""}]' );
                    
                    if (w.on)
                    {
                        w.on('open', glsEditorSupport.onEditorConnectionOpen);
                        w.on('close', glsEditorSupport.onEditorConnectionClose);
                        w.on('message', glsEditorSupport.onEditorMessage);
                        w.on('error', glsEditorSupport.onEditorConnectionError);                    
                    }
                    else
                    {
                        w.onopen = glsEditorSupport.onEditorConnectionOpen;
                        w.onclose = glsEditorSupport.onEditorConnectionClose;
                        w.onmessage = function(event) { 
                            if(typeof event.data === "string" ) 
                            {
                                glsEditorSupport.onEditorMessage(event.data) ;
                            }
                            else
                            {
                                console.log("Unexpectedly received binary data");
                            }                        
                        };
                        w.onerror = glsEditorSupport.onEditorConnectionError;
                    }
            });
            
        },

        onDataNameMap: {},
        onDataName: function( name, func )
        {
            // Only supporting one callback per name for now
            glsEditorSupport.onDataNameMap[name] = func
        },
        fireOnDataName: function( name, data )
        {
            // Only supporting one callback per name for now
            if (glsEditorSupport.onDataNameMap.hasOwnProperty(name))
            {
                glsEditorSupport.onDataNameMap[name]( data );
            }
        },        
        onEditorMessage: function (msg)
        {
            var dataArray = JSON.parse(msg);
            for (var i=0; i < dataArray.length; i++)
            {
                var data = dataArray[i];
                glsEditorSupport.fireOnDataName(data.name, data);
            }
        },

        onEditorConnectionOpen: function(evt)
        {
            glsEditorSupport.connection = glsEditorSupport.websocket;
            //console.log("connected to GL Studio Editor");
            
            glsEditorSupport.onDataName( "RequestCachedData", function()
            {
                // Send the cached data (not to be confused with queued data)
                var arrayToSend = [];
                for (var name in glsEditorSupport.cachedData) 
                {
                    if (glsEditorSupport.cachedData.hasOwnProperty(name)) 
                    {
                        arrayToSend.push({"name":name, "value":glsEditorSupport.cachedData[name]});
                    }
                }
                if (arrayToSend.length && glsEditorSupport.connection)
                {
                    var msg = JSON.stringify(arrayToSend);
                    glsEditorSupport.connection.send(msg);                    
                }
            });
            
            glsEditorSupport.sendQueuedMessagesToEditor();
            
            // There is a lot of data to be sent from here, so we want to send it in batches to avoid the
            // overhead of processing a bunch of small messages continuously.
            setInterval(function()
            {
                    glsEditorSupport.sendQueuedMessagesToEditor();
            },
            200);
        },

        onEditorConnectionClose: function(evt)
        {
            console.log("disconnected from GL Studio Editor");
            glsEditorSupport.connection = null; 
            glsEditorSupport.connectionClosed = true;
            glsEditorSupport.messagesQueued = [];
        },

        onEditorConnectionError: function(evt)
        {
            console.log('WebSocket error: ' + evt.data + '\n');

            glsEditorSupport.connection.close();
        },

        sendQueuedMessagesToEditor: function()
        {
            if (glsEditorSupport.connection)
            {
                if (glsEditorSupport.messagesQueued.length > 0)
                {
                    // Remove unused elements from the list.  These were allowed for performance.  Take the hit here.
                    var arrayToSend = [];
                    for (var index in glsEditorSupport.messagesQueued)
                    {
                        arrayToSend.push(glsEditorSupport.messagesQueued[index])
                    }
                    glsEditorSupport.messagesQueued = []
                
                    var msg = JSON.stringify(arrayToSend);
                    glsEditorSupport.connection.send(msg);
                }
            }
        },        
        queueMessageToEditor: function(name, value, compressCount /* 0 == no compression*/, subName)
        {
            // If the connection is closed, drop all messages
            if (!glsEditorSupport.connectionClosed)
            {
                if (compressCount > 0)
                {
                    // Find the nth entry in the current queue, and delete it.  Still add the new value at the end.
                    
                    subName = subName || "";

                    if (subName)
                    {
                        // Search including the subName
                        var count=0; 
                        for (var index in glsEditorSupport.messagesQueued)
                        {
                            var entry = glsEditorSupport.messagesQueued[index];
                            if (name === entry.name && subName in entry.value && entry.value[subName] === value[subName])                            
                            {
                                count++;
                                if ( count >= compressCount )
                                {
                                    delete glsEditorSupport.messagesQueued[index];
                                }                        
                            }
                        }
                    }
                    else
                    {
                        // Search for the name 
                        var count=0; 
                        for (var index in glsEditorSupport.messagesQueued)
                        {
                            var entry = glsEditorSupport.messagesQueued[index];
                            if (name === entry.name)
                            {
                                count++;                            
                                if ( count >= compressCount )
                                {
                                    delete glsEditorSupport.messagesQueued[index];
                                }                        
                            }
                        }
                    }
                }
                glsEditorSupport.messagesQueued.push({"name":name, "value":value});
            }
        },

        BeginsWith: function(needle, haystack)
        {
            return (haystack.substr(0, needle.length) == needle);
        },

        HandleSpecialIncoming:  function(topic, value)
        {
            var rval = false;
            var eventName = "";
            if (glsEditorSupport.BeginsWith("StateMachineSystem/FromCoordinator/AttributeUpdate/", topic))
            {
                eventName = topic.substring("StateMachineSystem/FromCoordinator/AttributeUpdate/".length);
                rval = false; // Just observing this change
            }                
            else if (glsEditorSupport.BeginsWith("StateMachineSystem/FromCoordinator/ObjectEvent/", topic))
            {
                eventName = topic.substring("StateMachineSystem/FromCoordinator/ObjectEvent/".length);

                // Fix up the object name, which is the embedded in the full name of the event
                var splitName = eventName.split(':');
                eventName = splitName.join(':');
                rval = false; // Just observing this change
            }                
            else if (glsEditorSupport.BeginsWith("StateMachineSystem/FromCoordinator/DevModeAttributeChanged/",topic))
            {
                eventName = topic.substring("StateMachineSystem/FromCoordinator/DevModeAttributeChanged/".length)
                rval = true; // Nobody else needs to handle this
            }
            else if (glsEditorSupport.BeginsWith("StateMachineSystem/FromCoordinator/DevModeObjectEvent/",topic))
            {
                eventName = topic.substring("StateMachineSystem/FromCoordinator/DevModeObjectEvent/".length)
                // Fix up the object name, which is the embedded in the full name of the event
                var splitName = eventName.split(':');
                eventName = splitName.join(':');
                rval = true; // Nobody else needs to handle this
            }            
            
            if (eventName)
            {
                glsEditorSupport.queueMessageToEditor("LogPropertyChanged", {'propertyName':eventName, 'propertyValue':value}, 3, 'propertyName');
            }
            return rval;
        },
        
        HandleSpecialOutgoing:  function(topic, value)
        {
            var rval = false;
            var eventName = "";
            if (glsEditorSupport.BeginsWith("StateMachineSystem/FromStateMachine/AttributeUpdate/", topic))
            {
                eventName = topic.substring("StateMachineSystem/FromStateMachine/AttributeUpdate/".length);
                rval = false; // Just observing this change
            }            
            else if(topic == "StateMachineSystem/FromStateMachine/ActiveBlockMomentary")
            {            
                glsEditorSupport.queueMessageToEditor("ActiveBlockMomentary", value, 0);
                rval = true;
            }        
            else if(topic == "StateMachineSystem/FromStateMachine/ActiveBlockData")
            {
                glsEditorSupport.cachedData["ActiveBlockData"] = value;
                
                glsEditorSupport.queueMessageToEditor("ActiveBlockData", value, 1);
                rval = true;
            }            
            if (eventName)
            {
                glsEditorSupport.queueMessageToEditor("LogPropertyChanged", {'propertyName':eventName, 'propertyValue':value}, 3, 'propertyName');
            }
            return rval;
        },        
    };
})();

var module = module || {};
module.exports = glsEditorSupport;