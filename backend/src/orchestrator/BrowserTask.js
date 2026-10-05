export function browserTask(text) {
 text=String(text||'').trim();let m;
 const call=(action,params={})=>({tool:'browser',action,params});
 if(m=text.match(/^(?:open|launch) (.+?) and (?:search(?: for)?|look up) (.+)$/i))return call('search',{browser:m[1],query:m[2]});
 if(m=text.match(/^(?:open|launch) (.+?) and (?:go to|navigate to|visit) (.+)$/i))return call('navigate',{browser:m[1],url:site(m[2])});
 if(m=text.match(/^search(?: for)? (.+?) (?:in|using) (.+)$/i))return call('search',{browser:m[2],query:m[1]});
 if(m=text.match(/^search(?: for)? (.+)$/i))return call('search',{query:m[1]});
 if(/^(?:open (?:a )?new tab|new tab)$/i.test(text))return call('newTab');
 if(/^close (?:the |this )?tab$/i.test(text))return call('closeTab');
 if(/^scroll (down|up)$/i.test(text))return call('scroll',{direction:text.split(' ')[1].toLowerCase()});
 if(/^(back|forward)$/i.test(text))return call(text.toLowerCase());
 if(/^open (?:the )?downloads(?: page)?$/i.test(text))return call('downloads');
 if(/^click (?:the )?first relevant result$/i.test(text))return call('click',{semanticIntent:'first_relevant_result'});
 return null;
}
function site(value){return ({github:'https://github.com',openai:'https://openai.com'})[value.toLowerCase()]||value;}
export const browserSchemas={
 openBrowser:{},attachBrowser:{},newTab:{url:'string'},closeTab:{tabId:'string'},switchTab:{tabId:'required'},navigate:{url:'required'},search:{query:'required'},
 click:{elementId:'string',semanticIntent:'string'},type:{elementId:'required',text:'required'},submit:{elementId:'required'},readText:{},scroll:{direction:'string'},
 getPageTitle:{},getCurrentUrl:{},getVisibleElements:{},waitForElement:{name:'required'},waitForNavigation:{url:'required'},back:{},forward:{},downloads:{}
};
