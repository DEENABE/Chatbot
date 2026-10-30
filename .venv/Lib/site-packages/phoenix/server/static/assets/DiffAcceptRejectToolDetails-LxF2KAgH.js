import{Ss as e,U as t,bs as n,ti as r,xs as i,ys as a}from"./vendor-streamdown-Zbu-dJSp.js";import{i as o,n as s,r as c,t as l}from"./index-CNCaZ_vQ.js";import{ToolPartDiffView as u}from"./ToolPartPierreViews-D7T6ZZYS.js";var d=e(),f=r`
  .diff-accept-reject__header {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: var(--global-dimension-size-100);
    padding: var(--global-dimension-size-100) var(--global-dimension-size-250)
      var(--global-dimension-size-50);
  }

  .diff-accept-reject__header-icon {
    flex-shrink: 0;
  }

  .diff-accept-reject__header-label {
    min-width: 0;
    color: var(--tool-call-secondary-color);
    text-transform: uppercase;
    font-size: var(--global-font-size-xs);
    letter-spacing: 0.05em;
    user-select: none;
  }
`;function p(e){let t=(0,d.c)(22),{part:r,pending:s,snapshotToText:u,fileName:p,renderHeader:h,preparingLabel:g,preparingText:_,staleSessionMessage:v,showPreparing:y}=e,b;t[0]!==p||t[1]!==s||t[2]!==h||t[3]!==u||t[4]!==v?(b=s==null?null:n(m,{pending:s,snapshotToText:u,fileName:p,renderHeader:h,staleSessionMessage:v}),t[0]=p,t[1]=s,t[2]=h,t[3]=u,t[4]=v,t[5]=b):b=t[5];let x;t[6]!==r.output||t[7]!==r.state?(x=r.state===`output-available`?i(a,{children:[n(o,{children:`Result`}),n(c,{children:l(r.output)})]}):null,t[6]=r.output,t[7]=r.state,t[8]=x):x=t[8];let S;t[9]!==r.errorText||t[10]!==r.state?(S=r.state===`output-error`?i(a,{children:[n(o,{variant:`danger`,children:`Error`}),n(c,{children:r.errorText??``})]}):null,t[9]=r.errorText,t[10]=r.state,t[11]=S):S=t[11];let C;t[12]!==s||t[13]!==g||t[14]!==_||t[15]!==y?(C=s==null&&y?i(a,{children:[n(o,{children:g}),n(c,{children:_})]}):null,t[12]=s,t[13]=g,t[14]=_,t[15]=y,t[16]=C):C=t[16];let w;return t[17]!==b||t[18]!==x||t[19]!==S||t[20]!==C?(w=i(`div`,{className:`tool-part__body`,css:f,children:[b,x,S,C]}),t[17]=b,t[18]=x,t[19]=S,t[20]=C,t[21]=w):w=t[21],w}function m(e){let r=(0,d.c)(27),{pending:a,snapshotToText:o,fileName:c,renderHeader:l,staleSessionMessage:f}=e,p=!!(a.accept&&a.reject),m;r[0]!==a||r[1]!==l?(m=l(a),r[0]=a,r[1]=l,r[2]=m):m=r[2];let h;r[3]===m?h=r[4]:(h=n(`div`,{className:`diff-accept-reject__header`,children:m}),r[3]=m,r[4]=h);let g;r[5]!==a.before||r[6]!==o?(g=o(a.before),r[5]=a.before,r[6]=o,r[7]=g):g=r[7];let _;r[8]!==a.after||r[9]!==o?(_=o(a.after),r[8]=a.after,r[9]=o,r[10]=_):_=r[10];let v;r[11]!==c||r[12]!==g||r[13]!==_?(v=n(u,{fileName:c,before:g,after:_}),r[11]=c,r[12]=g,r[13]=_,r[14]=v):v=r[14];let y,b;r[15]===a?(y=r[16],b=r[17]):(y=()=>void a.accept?.(),b=()=>void a.reject?.(),r[15]=a,r[16]=y,r[17]=b);let x=!p,S;r[18]!==f||r[19]!==y||r[20]!==b||r[21]!==x?(S=n(s,{onAccept:y,onReject:b,isDisabled:x,staleMessage:f}),r[18]=f,r[19]=y,r[20]=b,r[21]=x,r[22]=S):S=r[22];let C;return r[23]!==h||r[24]!==v||r[25]!==S?(C=i(t,{direction:`column`,gap:`size-100`,children:[h,v,S]}),r[23]=h,r[24]=v,r[25]=S,r[26]=C):C=r[26],C}export{p as DiffAcceptRejectToolDetails};