import {createHash} from 'node:crypto';
/** Only the current authenticated user's text is eligible. Never scan RAG or model output. */
export function extractMemoryCandidates(message,{origin='user'}={}) {
 if(origin!=='user'||typeof message!=='string')return [];
 let m=message.match(/^(?:remember (?:that )?I prefer|from now on (?:please )?reply in)\s+([\p{L} -]{2,40})[.!]?$/iu);
 if(m&&(/^from now on/i.test(message)||/^(tamil|english|hindi|telugu|kannada|malayalam|marathi|bengali|gujarati|punjabi|odia|urdu|assamese|nepali|sanskrit|french|german|spanish|arabic|japanese|korean|chinese|russian)$/i.test(m[1].trim())))return [{key:'preferred_language',value:m[1].replace(/[.!]$/,'').trim(),category:'preference',explicit:true}];
 m=message.match(/^remember (?:that )?(.{1,2000})$/is);
 if(m)return [{key:'fact.'+createHash('sha256').update(m[1].toLowerCase()).digest('hex').slice(0,16),value:m[1],category:'fact',explicit:true}];
 m=message.match(/^I always use (.{1,100})[.!]?$/i);
 if(m)return [{key:'preferred_application',value:m[1],category:'preference',explicit:false}];
 return [];
}
