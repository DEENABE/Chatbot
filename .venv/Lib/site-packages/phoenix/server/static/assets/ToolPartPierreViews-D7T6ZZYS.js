import{F as e,I as t,Yt as n}from"./vendor-C9Avcih8.js";import{Ss as r,bs as i,ti as a}from"./vendor-streamdown-Zbu-dJSp.js";import{I as o}from"./contexts-BKFoPZQy.js";var s=r(),c=`
  pre, pre code, [data-line-type=context], [data-gutter], svg {
    background: var(--tool-call-body-background-color);
    stroke: unset;
    fill: unset;
  }

  [data-line-type] {
    border-right: none;
  }

  [data-code] {
    padding: 0;
    padding-bottom: var(--global-dimension-size-100)
  }

  [data-column-number] {
    padding-left: 1.5ch;
  }
`,l=a`
  font-family: var(--global-font-family-sans);
  white-space: normal;
`,u={light:`pierre-light`,dark:`pierre-dark`};function d(e){let n=(0,s.c)(8),{fileName:r,contents:a}=e,{theme:d}=o(),f;n[0]!==a||n[1]!==r?(f={name:r,contents:a},n[0]=a,n[1]=r,n[2]=f):f=n[2];let p;n[3]===d?p=n[4]:(p={disableFileHeader:!0,theme:u,themeType:d,unsafeCSS:c},n[3]=d,n[4]=p);let m;return n[5]!==f||n[6]!==p?(m=i(`div`,{className:`tool-part-pierre-view`,css:l,children:i(t,{file:f,options:p})}),n[5]=f,n[6]=p,n[7]=m):m=n[7],m}function f(t){let r=(0,s.c)(9),{fileName:a,before:d,after:f}=t,{theme:p}=o(),m;r[0]!==f||r[1]!==d||r[2]!==a?(m=n({name:a,contents:d},{name:a,contents:f}),r[0]=f,r[1]=d,r[2]=a,r[3]=m):m=r[3];let h=m,g;r[4]===p?g=r[5]:(g={diffStyle:`unified`,disableFileHeader:!0,theme:u,themeType:p,unsafeCSS:c},r[4]=p,r[5]=g);let _;return r[6]!==h||r[7]!==g?(_=i(`div`,{className:`tool-part-pierre-view`,css:l,children:i(e,{fileDiff:h,"data-background":`transparent`,options:g})}),r[6]=h,r[7]=g,r[8]=_):_=r[8],_}export{f as ToolPartDiffView,d as ToolPartFileView};