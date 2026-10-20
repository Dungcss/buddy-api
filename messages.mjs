import {isObject,id,invalid,upstreamError,onlyKeys,string,modelAndStream,sampling,positiveTokens,imagePart,functionTool,mapUsage,event,toolArguments,accumulator} from './protocol-common.mjs';

function textBlocks(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid();
  return value.map(block => { onlyKeys(block,['type','text','cache_control']); if(block.type !== 'text') invalid('unsupported_feature'); return string(block.text,{empty:true}); }).join('\n');
}
function contentPart(block) {
  if (block.type === 'text') { onlyKeys(block,['type','text','cache_control']);return {type:'text',text:string(block.text,{empty:true})}; }
  if (block.type === 'image') {
    onlyKeys(block,['type','source','cache_control']);
    const source=block.source;
    if (!isObject(source)) invalid();
    if (source.type === 'url') {onlyKeys(source,['type','url']);return imagePart(source.url);}
    if (source.type === 'base64') {onlyKeys(source,['type','media_type','data']);string(source.media_type);string(source.data);return imagePart(`data:${source.media_type};base64,${source.data}`);}
  }
  invalid('unsupported_feature');
}
function toolResult(block) {
  onlyKeys(block,['type','tool_use_id','content','is_error','cache_control']);
  if (block.is_error !== undefined && typeof block.is_error !== 'boolean') invalid();
  let content=block.content === undefined ? '' : textBlocks(block.content);
  if (block.is_error) content='Tool error: '+content;
  return {role:'tool',tool_call_id:string(block.tool_use_id),content};
}
export function messagesToChat(request) {
  onlyKeys(request,['model','messages','system','max_tokens','stream','tools','tool_choice','temperature','top_p','top_k','stop_sequences','metadata','thinking','service_tier']);
  const chat={...modelAndStream(request),messages:[],max_tokens:positiveTokens(request.max_tokens)};
  sampling(request,chat);
  if (request.thinking !== undefined) {
    onlyKeys(request.thinking,['type']);
    if (request.thinking.type !== 'disabled') invalid('unsupported_feature');
    chat.reasoning_effort='none';
  }
  if (request.service_tier !== undefined && request.service_tier !== 'auto') invalid('unsupported_feature');
  if (request.top_k !== undefined) { if(!Number.isInteger(request.top_k)||request.top_k<0)invalid();chat.top_k=request.top_k; }
  if (request.system !== undefined) chat.messages.push({role:'system',content:textBlocks(request.system)});
  if (!Array.isArray(request.messages)||!request.messages.length||request.messages.length>2000) invalid();
  for (const message of request.messages) {
    onlyKeys(message,['role','content']);
    if (!['user','assistant'].includes(message.role)) invalid();
    if (typeof message.content === 'string') {chat.messages.push({role:message.role,content:message.content});continue;}
    if (!Array.isArray(message.content)) invalid();
    let parts=[],calls=[];
    const flush=()=>{
      if(parts.length||calls.length)chat.messages.push({role:message.role,content:parts.length ? (parts.every(p=>p.type==='text') ? parts.map(p=>p.text).join('') : parts) : null,...(calls.length?{tool_calls:calls}:{})});
      parts=[];calls=[];
    };
    for (const block of message.content) {
      if (!isObject(block)) invalid();
      if (block.type === 'tool_result') {
        if(message.role!=='user')invalid();flush();chat.messages.push(toolResult(block));
      } else if (block.type === 'tool_use') {
        if(message.role!=='assistant')invalid();
        onlyKeys(block,['type','id','name','input','cache_control']);
        if(!isObject(block.input))invalid();
        calls.push({id:string(block.id),type:'function',function:{name:string(block.name),arguments:JSON.stringify(block.input)}});
      } else {
        if(message.role==='assistant'&&block.type!=='text')invalid('unsupported_feature');
        parts.push(contentPart(block));
      }
    }
    flush();
  }
  if(!chat.messages.length)invalid();
  if(request.stop_sequences!==undefined){if(!Array.isArray(request.stop_sequences)||request.stop_sequences.some(x=>typeof x!=='string'))invalid();chat.stop=request.stop_sequences;}
  if(request.tools!==undefined){
    if(!Array.isArray(request.tools)||request.tools.length>128)invalid();
    chat.tools=request.tools.map(tool=>{
      onlyKeys(tool,['type','name','description','input_schema','cache_control','strict']);
      if(tool.type!==undefined&&tool.type!=='custom')invalid('unsupported_feature');
      return functionTool({name:tool.name,description:tool.description,parameters:tool.input_schema,strict:tool.strict});
    });
  }
  if(request.tool_choice!==undefined){
    const choice=request.tool_choice;
    onlyKeys(choice,['type','name','disable_parallel_tool_use']);
    if(choice.disable_parallel_tool_use!==undefined){if(typeof choice.disable_parallel_tool_use!=='boolean')invalid();chat.parallel_tool_calls=!choice.disable_parallel_tool_use;}
    if(choice.type==='tool')chat.tool_choice={type:'function',function:{name:string(choice.name)}};
    else if(['auto','none','any'].includes(choice.type))chat.tool_choice=choice.type==='any'?'required':choice.type;
    else invalid('unsupported_feature');
  }
  return chat;
}
function stopReason(finish, hasTools, hasRefusal) {
  if(finish==='length')return 'max_tokens';
  if(finish==='content_filter'||hasRefusal)return 'refusal';
  if(hasTools)return 'tool_use';
  return 'end_turn';
}
function messageUsage(usage) {const u=mapUsage(usage);return {input_tokens:u.input_tokens,output_tokens:u.output_tokens};}
export function messageFromCompletion(completion,request) {
  const choice=completion.choices?.[0];if(!choice)upstreamError();
  const message=choice.message||{};
  const content=[];
  if(message.content)content.push({type:'text',text:message.content});
  if(message.refusal)content.push({type:'text',text:message.refusal});
  for(const call of message.tool_calls||[])content.push({type:'tool_use',id:call.id,name:call.function.name,input:toolArguments(call.function.arguments)});
  if(!content.length)content.push({type:'text',text:''});
  return {id:id('msg_'),type:'message',role:'assistant',model:request.model,content,stop_reason:stopReason(choice.finish_reason,message.tool_calls?.length,message.refusal),stop_sequence:null,usage:messageUsage(completion.usage)};
}
export async function* streamMessages(chunks,request) {
  const messageId=id('msg_');const acc=accumulator(request.model);
  let nextIndex=0,textIndex=null;const open=new Set();
  yield event('message_start',{message:{id:messageId,type:'message',role:'assistant',model:request.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});
  for await(const chunk of chunks){
    const delta=acc.push(chunk);
    if(delta.text||delta.refusal){
      if(textIndex===null){textIndex=nextIndex++;open.add(textIndex);yield event('content_block_start',{index:textIndex,content_block:{type:'text',text:''}});}
      yield event('content_block_delta',{index:textIndex,delta:{type:'text_delta',text:delta.text+delta.refusal}});
    }
    for(const {tool,argumentsDelta} of delta.tools){
      if(!tool.started && tool.id && tool.name && tool.arguments){
        tool.started=true;tool.outputIndex=nextIndex++;open.add(tool.outputIndex);
        yield event('content_block_start',{index:tool.outputIndex,content_block:{type:'tool_use',id:tool.id,name:tool.name,input:{}}});
        if(tool.arguments)yield event('content_block_delta',{index:tool.outputIndex,delta:{type:'input_json_delta',partial_json:tool.arguments}});
      }else if(tool.started && argumentsDelta)yield event('content_block_delta',{index:tool.outputIndex,delta:{type:'input_json_delta',partial_json:argumentsDelta}});
    }
  }
  acc.validate();
  for(const tool of acc.state.tools.values()){
    if(!tool.started){
      tool.started=true;tool.outputIndex=nextIndex++;open.add(tool.outputIndex);
      yield event('content_block_start',{index:tool.outputIndex,content_block:{type:'tool_use',id:tool.id,name:tool.name,input:{}}});
      if(tool.arguments)yield event('content_block_delta',{index:tool.outputIndex,delta:{type:'input_json_delta',partial_json:tool.arguments}});
    }
    if(acc.state.finish!=='length')toolArguments(tool.arguments);
  }
  if(!open.size){textIndex=nextIndex++;open.add(textIndex);yield event('content_block_start',{index:textIndex,content_block:{type:'text',text:''}});}
  for(const index of open)yield event('content_block_stop',{index});
  yield event('message_delta',{delta:{stop_reason:stopReason(acc.state.finish,acc.state.tools.size,acc.state.refusal),stop_sequence:null},usage:messageUsage(acc.state.usage)});
  yield event('message_stop');
}
