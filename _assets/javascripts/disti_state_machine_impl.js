'use strict';

// See https://github.com/steelbreeze/state.js/blob/master/doc/state.com.md

if (typeof require != 'undefined')
{
  global.state = require("state.js");
}
var distiStateMachine = {};
distiStateMachine = {

valueCache: {},

machines: {},

localTimeData: {startTime: 0.0, sinceStart:0.0, lastUpdateTime:0.0},

// Used during traversals as a way for all code to know what event is being processed
// PORT WARNING: This can cause problems in a multi-threaded system.  JavaScript in the web browser, is not.
currentEvent: null,

internalSetHandleQueue: [],

// Anti recursion logic
recursionCheckCount: 100,
internalSetResourceFrameCount: {},
internalSetResourceBlackList: {},

internalStateReporter: null,

//////////// Creation
ClearAll: function()
{
    this.machines = {}
},
CreateStateMachine: function( ownerId, machineName, stateData )
{

    //states = [ {stateName, enterFunc, exitFunc, [subStates], [transitions]}, ... ]
    //transition = { eventName, eventValue }
    
    // send log messages, warnings and errors to the console
    //state.console = console;
    
    // ownerId + machineName should be completely unique among all state machines.
    var fullMachineName = ownerId + ":" + machineName 
    
    //console.log("Creating Machine: "+fullMachineName);
    var machine = new state.StateMachine(machineName);

    this.machines[fullMachineName] = { machine: machine, instance: null };

    this.CreateStatesFromData( machine, stateData, true );
/*    
    // create the state machine model elements
    var model = new state.StateMachine("model");
    var initial = new state.PseudoState("initial", model, state.PseudoStateKind.Initial);
    var stateA = new state.State("stateA", model);
    var stateB = new state.State("stateB", model);

    // create the state machine model transitions
    initial.to(stateA);
    stateA.to(stateB).when(function (message) { return message === "move"; });

*/
    // create a state machine instance
    var instance = new state.StateMachineInstance(machineName); // Keeping the machine name and instance name the same
    
    this.machines[fullMachineName].instance = instance;
    
    // initialise the model and instance
    state.initialise(machine, instance);

    return machine;
},
DestroyStateMachines: function()
{
    for (var i in this.machines)
    {
        console.log("Destroying state machine: "+i);
        delete this.machines[i];            
    }
},
CreateStatesFromData: function( machine, stateData, atTop )
{
    var processingFirstState = true;
    var firstState = null;
    for (var s in stateData)
    {
        var newState = this.CreateState( machine, stateData[s] );
        if (processingFirstState)
        {
            firstState = newState;
            processingFirstState = false;                       
        }
    }    
    if (firstState)
    {
        // The first in our array is our initial state
        var initial = new state.PseudoState("initial", machine, state.PseudoStateKind.Initial);        
        if (true)
        {
            initial.to(firstState);
        }
    }
},
CreateState: function( machine, stateDatum )
{
    //stateName, entryFunc, exitFunc, subStates, transitions
    if (this.FindStateByName( machine, stateDatum.stateName))
    {
        throw "ERROR: duplicate state name of '"+stateDatum.stateName+"' in "+machine.toString();
    }
    
    var newState = new state.State( stateDatum.stateName, machine);
    
    // We are monkey patching the entry time into the state, so we are leading with "disti_"
    newState.disti_entryTime = null;    
    
    var entryFuncCaller = (function(){
        var localFunc = stateDatum.entryFunc; 
        return function ()
        {
            newState.disti_entryTime = distiStateMachine.GetTimeSinceStart();
            newState.disti_lastEntryTimeEventFired = -1;
            newState.disti_lastFrameRateEventFired = {};
            if (localFunc)
            {
                localFunc( newState );
            }
        }
        })();
    newState.entry( entryFuncCaller );
    
    var exitFuncCaller = (function(){
        var localFunc = stateDatum.exitFunc; 
        return function ()
        {
            if (localFunc)
            {
                localFunc( newState );
            }
            newState.disti_entryTime = null;
            newState.disti_lastEntryTimeEventFired = null;
            newState.disti_lastFrameRateEventFired = null;
        }
        })();
    newState.exit( exitFuncCaller );
    
    this.CreateStatesFromData( newState, stateDatum.subStates, false )
    
    for (var t in stateDatum.transitions)    
    {
        var datum = stateDatum.transitions[t]
        var newTransition = newState.to( null, state.TransitionKind.Internal );
        if (datum.triggerConditions)
        {
            if (!Array.isArray( datum.triggerConditions ))
            {
                console.log("triggerConditions should be an array, but is not!");
            }
            else
            {
                newTransition.when( this.CreateEventFilter( datum.triggerConditions, newState ) );
                //var func = datum.actionFunc;
                var actionFuncCaller = (function(){
                    var localFunc = datum.actionFunc; 
                    return function ()
                    {
                        if (localFunc)
                        {
                            localFunc( newState );
                        }
                    }
                    })();
                newTransition.effect( actionFuncCaller );
            }
        }        
    }    
    this.SaveStateByName( machine, stateDatum.stateName, newState );
    
    //console.log("Created State: "+ newState.toString());
    return newState;
},
EvaluatorPropertyEventValue: function( message , eventData )
{
    var propName = eventData.eventNameFilter;
    var propValue = eventData.eventValueFilter;                
    
    //console.log("Evaluating: "+propName +" "+ propValue +" against:\n            "+message.name+" "+message.value) ;
    // TODO: Make this a filter
    var rval = (message.name == propName && (propValue == "*" || message.value == propValue));
    if (rval && eventData.reportFunc)
    {
        eventData.reportFunc(); // For visualization/debugging
    }
    return  rval;
},
EvaluatorNetworkEventValue: function( message , eventData )
{
    var rawHeader = "RAW_NETWORK_MESSAGE:"
    if (message.name.substring(0, rawHeader.length) != rawHeader)
    {
        return false;
    }
    var rawName = message.name.substring(rawHeader.length);
        
    var propValue = eventData.eventValueFilter;                
    
    var rval = (rawName == eventData.eventNameFilter && (propValue == "*" || message.value == propValue));
    
    if (rval && eventData.reportFunc)
    {
        eventData.reportFunc(); // For visualization/debugging
    }
    return rval;
},
EvaluatorObjectEventValue: function( message , eventData )
{
    var splitMessageName = message.name.split(':');
    var splitDataName = eventData.eventNameFilter.split(':');
    if (splitMessageName[0] != splitDataName[0])
    {
        // The event name doesn't match
        return false;
    }
    if (splitMessageName.length < 2 || 
        splitDataName.length < 2 )
    {
        console.log("Problem in EvaluatorObjectEventValue with malformed eventData or message");
        return false;
    }
    
    if (splitDataName[1] != "*" &&
        splitDataName[1]  != splitMessageName[1])
    {
        // The initiator doesn't match
        return false;
    }
        
    var propValue = eventData.eventValueFilter;                              
    var rval = (propValue == "*" || message.value == propValue);
    
    if (rval && eventData.reportFunc)
    {
        eventData.reportFunc(); // For visualization/debugging
    }
    return rval;
},
EvaluatorTimeInState: function( message , eventData, containingState )
{
    var rval = false;
    if ("CHECK_TIME_EVALUATORS" == message.name)
    {
        var now = parseFloat( message.value );
        var timeInThisState = now - containingState.disti_entryTime;

        if ("TIME_EVALUATOR_TIME_IN_STATE"==eventData.eventNameFilter)
        {
            var targetTime = parseFloat(eventData.eventValueFilter);
            
            if (timeInThisState >= targetTime && containingState.disti_lastEntryTimeEventFired < targetTime)
            {
                containingState.disti_lastEntryTimeEventFired = targetTime;
                
                rval = true;
            }
        }
        else if ("TIME_EVALUATOR_UPDATE_RATE"==eventData.eventNameFilter)
        {
            var targetTime = parseFloat(eventData.eventValueFilter);
            
            if (!containingState.disti_lastFrameRateEventFired.hasOwnProperty(eventData.eventValueFilter))
            {
                containingState.disti_lastFrameRateEventFired[eventData.eventValueFilter]  = -1.0;
            }
            var lastUpdateTime = containingState.disti_lastFrameRateEventFired[eventData.eventValueFilter];            
            
            if (timeInThisState - lastUpdateTime >= targetTime)
            {
                // Save the current time in the object using the update rate as a key
                // TODO: Document the fact that two or more entries with the same update rate will only be called on one.
                containingState.disti_lastFrameRateEventFired[eventData.eventValueFilter] = timeInThisState;
                
                rval = true;
            }
        }
        if (rval && eventData.reportFunc)
        {
            eventData.reportFunc(); // For visualization/debugging
        }
        
     }        
     return rval;
},
CreateEventFilter: function( eventFilterArrayArg, containingState )
{
    return (function()
    {
        var eventFilterArray = eventFilterArrayArg;
        
        var func = function( message )
        {
            if (!message)
                return false;
          
            for (var d in eventFilterArray)
            {
                var entry = eventFilterArray[d];
                if (!entry)
                {
                    continue;
                }
                
                var rval = entry.filterEvaluator( message, entry.filterData, containingState );
                                
                if (rval)
                {
                    break;
                }
            }
            return rval;
        }
        return func;
    })();
},
FindStateByName: function( machine, name )
{
    var topMachine = machine.getRoot();
    if (!topMachine["gls_state_mapping"])
        return null;
    return topMachine.getRoot()["gls_state_mapping"][name];    
},
SaveStateByName: function( machine, name, stateObject )
{
    // TODO: Figure out how to search the machine properly for these names instead of monkey patching them into our own list.        
    var topMachine = machine.getRoot();
    if (!topMachine["gls_state_mapping"])
    {
        topMachine["gls_state_mapping"] = {}
    }
    topMachine.getRoot()["gls_state_mapping"][name] = stateObject;    
},
//////////////////// Runtime
GoToState: function( currentState, targetStateString )
{
    if (!currentState || !targetStateString)
    {
        return; // Not valid so ignoring
    }
    //console.log("in GoToState: ",targetStateString );
    try {
        var targetState = this.FindStateByName( currentState.getRoot(), targetStateString);
        
        var targetChildOfCurrent = !(-1 === targetState.ancestry().indexOf(currentState));
        var newCurrent = null;
        
        if (targetChildOfCurrent)
        {
            // If the target is a child of the current, try to transition from the state closest to the target.
            var getClosestCurrent = function(target)
            {
                if (!target)
                {
                    return null;
                }
                var candidate = global.currentlyEvaluatingStateMachineInstance.getCurrent(target.region);
                if (candidate)
                {
                    return candidate;
                }
                else
                {
                    return getClosestCurrent(target.parent);
                }                
            }
            // Get the current closest to the targetState
            currentState = getClosestCurrent(targetState);
        }
        
        if (currentState == targetState)
        {
            // TODO: There is probably a fancy transition type that allows us to transition to the same state we are in... but this is doing what we want:            
            currentState.exitBehavior.invoke();
            currentState.entryBehavior.invoke()
        }
        else if (targetState)
        {
            var transition = currentState.to(targetState).when(function(){return true;});
            
            // If the target state is not contained within our currentState we are doing external?
            transition.kind = (-1 === targetState.ancestry().indexOf(currentState)) ? 2 : 1;
            
            transition.effect((function() 
            {
                var localTransition = transition;
                return function() {
                    localTransition.remove();
                }
            })());
        }
        else
        {
            console.log("Didn't find state "+targetStateString +". Ignoring GoToState()");
        }
    }
    catch (e)
    {
        console.log("Problem going to state in GoToState: " + e );
    }
},
LaunchAnimation: function( value )
{
    this.sendMessage("StateMachineSystem/FromStateMachine/LaunchAnimation", value);    
},
CancelAnimationByAttributeName: function( value )
{
    this.sendMessage("StateMachineSystem/FromStateMachine/CancelAnimationByAttributeName", value);    
},
SetResource: function( name, value )
{
    this.valueCache[name] = value;
    if (this.AddToInternalSetQueue_(  { name: name.toString(), value: value.toString() } ))
    {
        this.sendMessage("StateMachineSystem/FromStateMachine/AttributeUpdate/"+name, value);
    }
},
ClearAntiRecursionCountList_:function()
{
    this.internalSetResourceFrameCount = {};
},
ResetRecursionBlackList:function()
{
    this.internalSetResourceBlackList = {}
},
AddToInternalSetQueue_: function( message )
{
    if (this.internalSetResourceBlackList[message.name])
    {
        return false;
    }
    
    var c;
    if ( c = this.internalSetResourceFrameCount[ message.name ])
    {
        this.internalSetResourceFrameCount[ message.name ] = c + 1;
        
        if (c > this.recursionCheckCount)
        {
            // Blacklist it
            this.internalSetResourceBlackList[message.name] = true;
            
            console.log("Infinite recursion suspected for: "+message.name+ ", adding it to the blacklist so no internal events will fire for it until an updated state machine is loaded.");
            return false;
        }
    }
    else
    {
        this.internalSetResourceFrameCount[ message.name ] = 1;
    }
    
    this.internalSetHandleQueue.push( message );

    return true;
},
GetResource: function( name )
{
    try {
        return this.valueCache[name];
    }
    catch (e)
    {
        console.log("Error in GetResource(), no value available for " + name + ", returning blank.");    
        return "";
    }
},
GetTimeSinceStart: function()
{
    return this.localTimeData.sinceStart;
},
GetTimeSinceLastUpdate: function()
{
    return this.localTimeData.sinceLastUpdate;
},
GetCurrentEventName: function()
{
    if (this.currentEvent == null)
    {
        console.log("Current Event not available in the current context");
        return "";
    }
    return this.currentEvent.name;
},
GetCurrentEventValue: function()
{
    if (this.currentEvent == null)
    {
        console.log("Current Event not available in the current context");
        return "";
    }
    return this.currentEvent.value;
},
// The selectArray specifies indicies to index into the whitespace separated values
SelectElementsFromValue: function( selectArray, value )
{
    if (!value)
    {
        return "ERROR_MISSING_DATA";
    }
    var splitArray = value.toString().trim().split(/\s+/);
    var rval = "";
    for (var i in selectArray)
    {
        if (i != 0)
        {
            rval += " ";       
        }
        var index = selectArray[i];
        if (index >= splitArray.length)
        {
            rval += "ERROR_MISSING_DATA";
        }
        else
        {
            rval += splitArray[index];
        }
    }
    return rval;
},
ReportEnteringState: function( state, blockId, ownerId, instanceId ) {
    if (!this.activeStateIds[ownerId])
    {   
        this.activeStateIds[ownerId] = {};
    }
    
    this.activeStateIds[ownerId][blockId] = true;
    this.SendActiveBlockDebugData();
},
ReportLeavingState: function( state, blockId, ownerId, instanceId ) {
    if (this.activeStateIds[ownerId])
    {   
        delete this.activeStateIds[ownerId][blockId];
    }
    this.SendActiveBlockDebugData();
},
ReportStatementBegin: function( blockId, ownerId, instanceId ) {
    this.sendMessage("StateMachineSystem/FromStateMachine/ActiveBlockMomentary", 
        JSON.stringify({"ownerId": ownerId, "blockId": blockId}));
},
activeStateIds: {},
SendActiveBlockDebugData: function() {

    this.sendMessage("StateMachineSystem/FromStateMachine/ActiveBlockData", 
         JSON.stringify({"activeStateIds": this.activeStateIds}));        

},
ClearBlockDebugData: function(ownerId) {
  this.activeStateIds[ownerId] = {}
  this.SendActiveBlockDebugData();
},
sendMessage: function() {
  console.log("NEED TO OVERRIDE sendMessage!!!");
},

// Used for sending raw network values
SendToNetworkId: function(name, value)
{
  console.log("NEED TO OVERRIDE SendToNetworkId!!!");
},

UpdateTime: function() 
{
    var d = new Date();
    var newTime = (d.getTime()-this.localTimeData.startTime) / 1000.0;
    var delta = newTime - this.localTimeData.lastUpdateTime;
    this.localTimeData.lastUpdateTime = newTime;     
    this.localTimeData.sinceStart += delta;

},
UtilAnyToBoolean: function(arg){
        switch (typeof arg){
            case "boolean":
                return arg?1:0;
            case "number":
                return arg==0?0:1;
            case "string":
                switch(arg.toLowerCase().trim()){
                    case "true": case "yes": case "1": return 1;
                    default: return 0;
                }
            }
},
ReplaceDelimitedData: function(startingString, replacementData)
{
    function replaceAll(str, find, replace) {
      return str.replace(new RegExp(find, 'g'), replace);
    }            
    for (var entry in replacementData) 
    {
        if (replacementData.hasOwnProperty(entry)) 
        {
            var data = replacementData[entry];
            startingString = replaceAll(startingString, "%"+entry+"%", data);
        }
    }
    return startingString;
},
UtilColorReplaceAlpha: function(colorAsString, newAlpha){
    var splitArray = colorAsString.trim().split(/\s+/);
    
    if (splitArray.length >= 3)
    {
        splitArray[3] = ""+newAlpha;
        return splitArray.join(" ");
    }
    else
    {
        return "0 0 0 " + newAlpha;
    }    
},
onMessageArrived: function(destinationName, payloadString)
{
    try
    {
        var message = {
            name: destinationName,
            value: payloadString
        };
        
        this.valueCache[message.name] = message.value;
        
        this.currentEvent = message;
        for (var i in this.machines)
        {
            var entry = this.machines[i];
            //console.log("Received: "+message.name+" : "+message.value);
            //console.log("Processing machine"+i+" which is: "+entry);
            try 
            {
                global.currentlyEvaluatingStateMachineInstance = entry.instance;
                state.evaluate(entry.machine, entry.instance, message);
                state.evaluate(entry.machine, entry.instance, null);// TODO: This is for the extra transition event.  Refactor
                global.currentlyEvaluatingStateMachineInstance = null;
            }
            catch (e)
            {
                console.log("Problem with machine.  Removing from execution!!!!!!!!!!!.  Why:"+i+": "+e +"\n"+e.stack);
                
                delete this.machines[i];    
            }
        }
        this.currentEvent = null;
    }
    catch (e)
    {
          console.log("Error evaluating network message for state machine: "+e +"\n"+e.stack);
    }
},
// As messages are processed, they may creating internal messages that need to be handled.  
// We queue them up and they are processed by calling this method.
processSideEffectMessages: function()
{    
    while (this.internalSetHandleQueue.length)
    {
        var message = this.internalSetHandleQueue.shift();
        this.onMessageArrived( message.name, message.value );
    }
    
    this.ClearAntiRecursionCountList_();
},
PollForTimeBasedEvents: function() //TODO: Remove the need for this
{
    var doCheck = function ()
    {
        distiStateMachine.UpdateTime();
        distiStateMachine.onMessageArrived( "CHECK_TIME_EVALUATORS", distiStateMachine.GetTimeSinceStart() );
    }
    setInterval( doCheck, 33 );    
},

};


if (typeof require != 'undefined')
{
    module.exports = distiStateMachine;
}