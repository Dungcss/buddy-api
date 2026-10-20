import {isObject,id,invalid,upstreamError,onlyKeys,string,modelAndStream,sampling,positiveTokens,imagePart,functionTool,mapUsage,event,accumulator} from './protocol-common.mjs';

function inputContent(value,role) {
  if(typeof value==='string')return value;
  if(!Array.isArray(value))invalid();
  return value.map(part=>{
    if(!isObject(part))invalid();
    if(part.type==='input_text'||(part.type==='output_text'&&role==='assistant')){
      onlyKeys(part,['type','text','annotations','logprobs']);return {type:'text',text:string(part.text,{empty:true})};
    }
    if(part.type==='input_image'&&role==='user'){
      onlyKeys(part,['type','image_url','detail']);return imagePart(part.image_url,part.detail);
    }
    if(part.type==='refusal'&&role==='assistant'){onlyKeys(part,['type','refusal']);return {type:'text',text:string(part.refusal,{empty:true})};}
    invalid('unsupported_feature');
  });
}
export function responsesToChat(request) {
  onlyKeys(request,['model','input','instructions','stream','max_output_tokens','temperature','top_p','tools','tool_choice','parallel_tool_calls','reasoning','text','store','previous_response_id','background','metadata','user','safety_identifier','prompt_cache_key','truncation','include','service_tier']);
  const chat={...modelAndStream(request),messages:[]};sampling(request,chat);
  if(request.store!==undefined&&request.store!==false)invalid('unsupported_feature');
  if(request.previous_response_id!=null||request.background===true)invalid('unsupported_feature');
  if(request.background!==undefined&&typeof request.background!=='boolean')invalid();
  if(request.truncation!==undefined&&request.truncation!=='disabled')invalid('unsupported_feature');
  if(request.include!==undefined&&(!Array.isArray(request.include)||request.include.length))invalid('unsupported_feature');
  if(request.service_tier!==undefined&&request.service_tier!=='auto')invalid('unsupported_feature');
  if(request.instructions!=null)chat.messages.push({role:'system',content:string(request.instructions,{empty:true})});
  if(request.max_output_tokens!==undefined)chat.max_tokens=positiveTokens(request.max_output_tokens);
  if(request.parallel_tool_calls!==undefined){if(typeof request.parallel_tool_calls!=='boolean')invalid();chat.parallel_tool_calls=request.parallel_tool_calls;}
  const input=typeof request.input==='string'?[{role:'user',content:request.input}]:request.input;
  if(!Array.isArray(input)||!input.length||input.length>2000)invalid();
  for(const item of input){
    if(!isObject(item))invalid();
    if(item.type==='function_call'){
      onlyKeys(item,['type','id','call_id','name','arguments','status']);
      const tool={id:string(item.call_id),type:'function',function:{name:string(item.name),arguments:string(item.arguments,{empty:true})}};
      const previous=chat.messages.at(-1);
      if(previous?.role==='assistant'&&previous.tool_calls)previous.tool_calls.push(tool);
      else chat.messages.push({role:'assistant',content:null,tool_calls:[tool]});
    }else if(item.type==='function_call_output'){
      onlyKeys(item,['type','id','call_id','output','status']);
      let output=item.output;
      if(Array.isArray(output)){
        output=output.map(part=>{onlyKeys(part,['type','text']);if(part.type!=='input_text')invalid('unsupported_feature');return string(part.text,{empty:true});}).join('\n');
      }
      chat.messages.push({role:'tool',tool_call_id:string(item.call_id),content:string(output,{empty:true})});
    }else{
      if(item.type!==undefined&&item.type!=='message')invalid('unsupported_feature');
      onlyKeys(item,['type','id','role','content','status']);
      if(!['system','developer','user','assistant'].includes(item.role))invalid();
      chat.messages.push({role:item.role,content:inputContent(item.content,item.role)});
    }
  }
  if(request.tools!==undefined){
    if(!Array.isArray(request.tools)||request.tools.length>128)invalid();
    chat.tools=request.tools.map(tool=>{
      onlyKeys(tool,['type','name','description','parameters','strict']);
      if(tool.type!=='function')invalid('unsupported_feature');
      return functionTool({...tool,parameters:tool.parameters??{}});
    });
  }
  if(request.tool_choice!==undefined){
    if(typeof request.tool_choice==='string'){
      if(!['auto','none','required'].includes(request.tool_choice))invalid('unsupported_feature');
      chat.tool_choice=request.tool_choice;
    }else{
      onlyKeys(request.tool_choice,['type','name']);if(request.tool_choice.type!=='function')invalid('unsupported_feature');
      chat.tool_choice={type:'function',function:{name:string(request.tool_choice.name)}};
    }
  }
  if(request.reasoning!=null){
    onlyKeys(request.reasoning,['effort','summary']);
    if(request.reasoning.summary!=null)invalid('unsupported_feature');
    if(request.reasoning.effort!=null){if(!['none','minimal','low','medium','high','xhigh','max'].includes(request.reasoning.effort))invalid();chat.reasoning_effort=request.reasoning.effort;}
  }
  if(request.text!==undefined){
    onlyKeys(request.text,['format']);
    if(request.text.format!==undefined){
      const format=request.text.format;
      if(!isObject(format))invalid();
      if(format.type==='text')onlyKeys(format,['type']);
      else if(format.type==='json_object'){onlyKeys(format,['type']);chat.response_format={type:'json_object'};}
      else if(format.type==='json_schema'){
        onlyKeys(format,['type','name','schema','strict','description']);
        if(!isObject(format.schema))invalid();string(format.name);
        if(format.strict!==undefined&&typeof format.strict!=='boolean')invalid();
        if(format.description!==undefined&&typeof format.description!=='string')invalid();
        chat.response_format={type:'json_schema',json_schema:{name:format.name,schema:format.schema,...(format.strict!==undefined?{strict:format.strict}:{}),...(format.description!==undefined?{description:format.description}:{})}};
      }else invalid('unsupported_feature');
    }
  }
  return chat;
}
function responseUsage(usage={}) {
  return {...mapUsage(usage),input_tokens_details:{cached_tokens:usage.prompt_tokens_details?.cached_tokens??usage.prompt_cache_hit_tokens??0},output_tokens_details:{reasoning_tokens:usage.completion_tokens_details?.reasoning_tokens??usage.completion_thinking_tokens??0}};
}
function baseResponse(request,responseId=id('resp_')) {
  return {id:responseId,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',background:false,error:null,incomplete_details:null,instructions:request.instructions??null,max_output_tokens:request.max_output_tokens??null,model:request.model,output:[],parallel_tool_calls:request.parallel_tool_calls??true,previous_response_id:null,store:false,temperature:request.temperature??1,top_p:request.top_p??1,tools:request.tools??[],tool_choice:request.tool_choice??'auto',truncation:'disabled',metadata:request.metadata??{},usage:null};
}
function complete(response,finish,usage) {
  response.status=['length','content_filter'].includes(finish)?'incomplete':'completed';
  response.incomplete_details=response.status==='incomplete'?{reason:finish==='length'?'max_output_tokens':'content_filter'}:null;
  response.usage=responseUsage(usage);
  for(const item of response.output)item.status=response.status;
  return response;
}
export function responseFromCompletion(completion,request) {
  const response=baseResponse(request),choice=completion.choices?.[0];if(!choice)upstreamError();
  const message=choice.message||{},content=[];
  if(message.content)content.push({type:'output_text',text:message.content,annotations:[],logprobs:[]});
  if(message.refusal)content.push({type:'refusal',refusal:message.refusal});
  if(content.length)response.output.push({type:'message',id:id('msg_'),role:'assistant',status:'completed',content});
  for(const call of message.tool_calls||[])response.output.push({type:'function_call',id:id('fc_'),call_id:call.id,name:call.function.name,arguments:call.function.arguments,status:'completed'});
  if(!response.output.length)response.output.push({type:'message',id:id('msg_'),role:'assistant',status:'completed',content:[{type:'output_text',text:'',annotations:[],logprobs:[]}]});
  return complete(response,choice.finish_reason,completion.usage);
}
export async function* streamResponses(chunks,request) {
  const response=baseResponse(request),acc=accumulator(request.model);let sequence=0,message=null,messageIndex=null;
  const parts=new Map();
  const emit=(type,data={})=>event(type,{sequence_number:sequence++,response_id:response.id,...data});
  // Snapshots must not share mutable output references with subsequent events.
  const snapshot=()=>structuredClone(response);
  yield emit('response.created',{response:snapshot()});
  yield emit('response.in_progress',{response:snapshot()});
  for await(const chunk of chunks){
    const delta=acc.push(chunk);
    for(const [kind,value] of [['output_text',delta.text],['refusal',delta.refusal]]){
      if(!value)continue;
      if(!message){
        message={type:'message',id:id('msg_'),role:'assistant',status:'in_progress',content:[]};messageIndex=response.output.length;response.output.push(message);
        yield emit('response.output_item.added',{output_index:messageIndex,item:structuredClone(message)});
      }
      let part=parts.get(kind);
      if(!part){
        part=kind==='output_text'?{type:kind,text:'',annotations:[],logprobs:[]}:{type:kind,refusal:''};
        const index=message.content.length;message.content.push(part);parts.set(kind,part);
        yield emit('response.content_part.added',{item_id:message.id,output_index:messageIndex,content_index:index,part:structuredClone(part)});
      }
      const contentIndex=message.content.indexOf(part);part[kind==='output_text'?'text':'refusal']+=value;
      yield emit(kind==='output_text'?'response.output_text.delta':'response.refusal.delta',{item_id:message.id,output_index:messageIndex,content_index:contentIndex,delta:value,...(kind==='output_text'?{logprobs:[]}:{})});
    }
    for(const {tool,argumentsDelta} of delta.tools){
      if(!tool.started&&tool.id&&tool.name&&tool.arguments){
        tool.started=true;tool.outputIndex=response.output.length;
        tool.item={type:'function_call',id:id('fc_'),call_id:tool.id,name:tool.name,arguments:'',status:'in_progress'};response.output.push(tool.item);
        yield emit('response.output_item.added',{output_index:tool.outputIndex,item:structuredClone(tool.item)});
        if(tool.arguments){tool.item.arguments=tool.arguments;yield emit('response.function_call_arguments.delta',{item_id:tool.item.id,output_index:tool.outputIndex,delta:tool.arguments});}
      }else if(tool.started&&argumentsDelta){tool.item.arguments=tool.arguments;yield emit('response.function_call_arguments.delta',{item_id:tool.item.id,output_index:tool.outputIndex,delta:argumentsDelta});}
    }
  }
  acc.validate();
  for(const tool of acc.state.tools.values())if(!tool.started){
    tool.started=true;tool.outputIndex=response.output.length;
    tool.item={type:'function_call',id:id('fc_'),call_id:tool.id,name:tool.name,arguments:'',status:'in_progress'};response.output.push(tool.item);
    yield emit('response.output_item.added',{output_index:tool.outputIndex,item:structuredClone(tool.item)});
    if(tool.arguments){tool.item.arguments=tool.arguments;yield emit('response.function_call_arguments.delta',{item_id:tool.item.id,output_index:tool.outputIndex,delta:tool.arguments});}
  }
  if(!response.output.length){
    message={type:'message',id:id('msg_'),role:'assistant',status:'in_progress',content:[]};messageIndex=0;response.output.push(message);
    yield emit('response.output_item.added',{output_index:0,item:structuredClone(message)});
    const part={type:'output_text',text:'',annotations:[],logprobs:[]};message.content.push(part);
    yield emit('response.content_part.added',{item_id:message.id,output_index:0,content_index:0,part:structuredClone(part)});
  }
  complete(response,acc.state.finish,acc.state.usage);
  for(let outputIndex=0;outputIndex<response.output.length;outputIndex++){
    const item=response.output[outputIndex];
    if(item.type==='message'){
      for(let contentIndex=0;contentIndex<item.content.length;contentIndex++){
        const part=item.content[contentIndex];
        yield emit(part.type==='output_text'?'response.output_text.done':'response.refusal.done',{item_id:item.id,output_index:outputIndex,content_index:contentIndex,...(part.type==='output_text'?{text:part.text,logprobs:[]}:{refusal:part.refusal})});
        yield emit('response.content_part.done',{item_id:item.id,output_index:outputIndex,content_index:contentIndex,part:structuredClone(part)});
      }
    }else yield emit('response.function_call_arguments.done',{item_id:item.id,output_index:outputIndex,name:item.name,arguments:item.arguments});
    yield emit('response.output_item.done',{output_index:outputIndex,item:structuredClone(item)});
  }
  yield emit(response.status==='incomplete'?'response.incomplete':'response.completed',{response:snapshot()});
}
