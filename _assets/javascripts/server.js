"use strict";

// Create a client connection
var client = client || global.client;
 
var preProcessedCodeById = preProcessedCodeById || global.preProcessedCodeById || {}; 
  
var distiStateMachine = distiStateMachine || require("./lib/disti_state_machine_impl");

var onReceiptExecute = {}

var ownerIdToCode =  {}
// Override sendMessage to do something useful
distiStateMachine.sendMessage = function( name, value )
{
    client.publish( name, value );
};

// Override to actually do something with the data
distiStateMachine.SendToNetworkId = function(name, value)
{
    var data = {"name":name, "value":value};
    client.publish("StateMachineSystem/FromStateMachine/SendToNetwork", JSON.stringify(data));
};

var alreadyConnected = false;
client.on('connect', function() { // When connected

    if (alreadyConnected)
    {
        console.log("reconnected.");
    }
    else
    {
        alreadyConnected = true;

        var reportStatus = function(status, id)
        {
            //console.log("REPORTING STATUS OF "+status+"for ID:"+id);
            //StateMachineRunner/Status/MoreUIElementsPage.gls/mainStateMachine
            client.publish("StateMachineRunner/Status/"+id, status);
        }
        var handleMessage = function(topic, message)
        {
            var beginsWith = function(needle, haystack){
                return (haystack.substr(0, needle.length) == needle);
            }
            //console.log("Got topic: "+topic+" with payload: "+message);
            
            var updateRunning = function( ownerId, instanceId )
            {            
                distiStateMachine.ResetRecursionBlackList(); // Assuming this update might fix it so we will give all state machines another chance to avoid recursion issues.
                distiStateMachine.ClearBlockDebugData( ownerId ); // In case anybody is watching debug data, clear it because it is about to become invalid
              
                //console.log("DOING updateRunning, "+ownerId +" "+ instanceId);
                  var code = "(function(ownerId, instanceId){ "+ownerIdToCode[ownerId].definition.code+" })('"+ownerId+"', '"+instanceId+"' );";        
                  
                  // loose the final name to have the name of the component
                  var prefix = (''+instanceId).split(".").slice(0,-1).join(".");

                  var projectId = "";              
                  code = code.replace(new RegExp("%PROJECT_ID%\\.", 'g'), projectId);                            
                  code = code.replace(new RegExp("%PROJECT_ID%", 'g'), projectId);                            
                  
                  // If we are doing a top level property, we have to loose the dot
                  if (0==prefix.length)
                  {
                    // Replace any %LOCAL% with the dot first
                    code = code.replace(new RegExp("%LOCAL%\\.", 'g'), prefix);                              
                  }
                  code = code.replace(new RegExp("%LOCAL%", 'g'), prefix);              
                                
                  var getReplacedAttribsArray = function( theSet )
                  {
                        var rval = []
                        for (var e in theSet)
                        {
                            if (theSet.hasOwnProperty(e))
                            {
                                var toPush = e;
                                  if (0==prefix.length)
                                  {
                                    toPush = toPush.replace(new RegExp("%LOCAL%\\.", 'g'), prefix)
                                  }
                                  toPush = toPush.replace(new RegExp("%LOCAL%", 'g'), prefix);
                                  
                                  if (0==projectId.length)
                                  {
                                    toPush = toPush.replace(new RegExp("%PROJECT_ID%\\.", "g"), projectId);
                                  }
                                  toPush = toPush.replace(new RegExp("%PROJECT_ID%", "g"), projectId);
                                  
                                  rval.push(toPush);                              
                                  
                            }
                        }
                        return rval;
                  }
                  var createAndStartStateMachine = function()
                  {                  
                    try {
                        eval(code);
                    } catch (e) {
                        console.log("\nAttempted to execute code:\n"+code) 
                        console.log("Error executing JS: "+e +"\n"+e.stack);
                        reportStatus("Error executing JS", ownerId);
                        return false;
                    }                                                      
                  };
                  
                  var setAttribs = getReplacedAttribsArray( ownerIdToCode[ownerId].definition.setAttributeList );
                  var getAttribs = getReplacedAttribsArray( ownerIdToCode[ownerId].definition.getAttributeList );                            
                  var consumeEvents = getReplacedAttribsArray( ownerIdToCode[ownerId].definition.consumeEventList );              
                  
                  if (setAttribs && setAttribs.length)
                  {
                    distiStateMachine.sendMessage( "StateMachineSystem/ExpectUpdatesFor", setAttribs.toString() );
                  }
                  if (getAttribs && getAttribs.length)
                  {
                    distiStateMachine.sendMessage( "StateMachineSystem/RequestUpdatesFor", getAttribs.toString() );
                  }
                  if (consumeEvents && consumeEvents.length)
                  {
                    distiStateMachine.sendMessage( "StateMachineSystem/RequestObjectEvents", consumeEvents.toString() );
                  }

                  // Defer running the state machine until we know that our requests for initial values (RequestUpdatesFor) have been handled
                  onReceiptExecute[ "StateMachineSystem/CoordinatorEcho:" + ownerId+"_"+instanceId ] = createAndStartStateMachine;
                  
                  // We know that they have been handled we we get this echo back.
                  distiStateMachine.sendMessage( "StateMachineSystem/RequestCoordinatorEcho", ownerId+"_"+instanceId );         

                  // Do network subscription for raw network ids
                  var theSet = ownerIdToCode[ownerId].definition.rawNetworkingIdToSubscribeTo;
                  for (var e in theSet)
                  {
                     if (theSet.hasOwnProperty(e))
                     {              
                        client.subscribe(e);
                     }
                  }

            }
            if (beginsWith( "StateMachineSystem/FromCoordinator/AttributeUpdate/",topic))
            {
                var propertyName = topic.substring("StateMachineSystem/FromCoordinator/AttributeUpdate/".length);
            
                distiStateMachine.onMessageArrived(propertyName, message.toString());
            }
            else if (beginsWith( "StateMachineSystem/FromCoordinator/ObjectEvent/",topic))
            {
                var eventNameColonInitiator = topic.substring("StateMachineSystem/FromCoordinator/ObjectEvent/".length);
            
                distiStateMachine.onMessageArrived(eventNameColonInitiator, message.toString());
            }       
            else if (beginsWith( "StateMachineSystem/FromCoordinator/InitialAttributeValue/",topic))
            {
                var propertyName = topic.substring("StateMachineSystem/FromCoordinator/InitialAttributeValue/".length);
            
                // Just quietly store the cached value for others to read
                distiStateMachine.valueCache[ propertyName ] = message.toString();
            }
            else if (topic ==  "StateMachineSystem/FromCoordinator/ReceivedFromNetwork")
            {
                try
                {
                    var data = JSON.parse( message.toString() );
                    distiStateMachine.onMessageArrived("RAW_NETWORK_MESSAGE:"+data.name, data.value);
                }
                catch (e) 
                {
                    console.log("Error parsing ReceivedFromNetwork: "+e);
                }
            }
            else if (topic == "StateMachineSystem/StopAll" )
            {   
                // Remove all pre-existing state machines
                distiStateMachine.ClearAll();
            }
            else if (beginsWith( "StateMachineSystem/PreProcessedDefines/javascript",topic))
            {
                if (!message || !message.length)
                {
                    console.log("... definition empty.");
                    return false;
                }
                //console.log("preProcessedCodeById: "+JSON.stringify(preProcessedCodeById));
                
                var newObj = JSON.parse( message );
                for (var i in newObj)
                {
                    if (newObj.hasOwnProperty(i))
                    {
                        preProcessedCodeById[ i ] = newObj[i];
                    }
                }    
          
                // Now go through and see if any existing instances need updating
                // Possible improvement: Consolidate this with other updateRunning logic elsewhere
                for (var ownerId in ownerIdToCode)
                {
                    if (ownerIdToCode.hasOwnProperty(ownerId))
                    {
                        if (newObj.hasOwnProperty(ownerId))
                        {
                            ownerIdToCode[ownerId].definition = preProcessedCodeById[ownerId];
                        
                            for (var i in ownerIdToCode[ownerId].instances)
                            {
                                updateRunning(ownerId, i);
                            }                            
                        }                        
                    }
                }
                return true;
                
            }
            else if (beginsWith( "StateMachineSystem/RunInstance/",topic))
            {
                var ownerId = topic.substring("StateMachineSystem/RunInstance/".length);            

                var instanceId = message;
                
                //console.log("####GOT RUN.  ownerId:"+ownerId+"  instanceId:"+instanceId+"####END");

                if (!ownerIdToCode[ownerId])
                {             
                    ownerIdToCode[ownerId] = {};
                    ownerIdToCode[ownerId].definition = {code:"", getAttributeList: {}, setAttributeList: {}, consumeEventList: {}, rawNetworkingIdToSubscribeTo: {}};
                    ownerIdToCode[ownerId].instances = {}                    
                    
                    if (ownerId in preProcessedCodeById)
                    {
                        ownerIdToCode[ownerId].definition = preProcessedCodeById[ownerId];
                    }
                }                
                ownerIdToCode[ownerId].instances[instanceId] = instanceId;
                
                updateRunning(ownerId, instanceId);
            }
            
            else if ( topic == "StateMachineSystem/CoordinatorAlive" )
            {
                if (message == "0")
                {
                    // If there are any machines that serve this now-dead coordinator, destroy them
                    distiStateMachine.DestroyStateMachines( );            
                    
                    for (var i in ownerIdToCode)
                    {
                        console.log("Destroying code for: "+i);
                        delete ownerIdToCode[i];            
                    }
                }
            }
            else if (onReceiptExecute.hasOwnProperty(topic+":"+message))
            {
                onReceiptExecute[topic+":"+message]();
                delete onReceiptExecute[topic+":"+message];
            }
            else if (topic == "StateMachineSystem/IsRunnerAlive" )
            {   
                // Simple challenge response so someone can see if this runner is running
                client.publish('StateMachineRunner/RunnerIsAlive','1');                
            }
            
            distiStateMachine.processSideEffectMessages();
            
        };
      client.on('message', function(topic, message, packet) {
          //console.log("Received '" + message + "' on '" + topic + "'");
          handleMessage(topic, message);
      });
      
      distiStateMachine.PollForTimeBasedEvents();
    }  
    
    client.subscribe('StateMachineSystem/IsRunnerAlive');
    
    // subscribe to a topic
    client.subscribe('StateMachineSystem/#');
    
    // publish a message to a topic
    client.publish('StateMachineRunner/Status', 'OK', function() {
        // console.log("Message is published");
        //client.end(); // Close the connection when published
    });  

});

