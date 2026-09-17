import { expect,test } from 'bun:test';
import { skillSessionSettings, normalizeSkillPolicy } from './skill-policy';
const skill=(name:string,path:string,source?:string,pluginId?:string)=>({name,path,source,pluginId,scope:'global' as const,summary:'',mtimeMs:0});
test('heavy skills are manual by default, explicit task choices override, ordinary skills retain automatic matching',()=>{
 const skills=[skill('brainstorming','/cache/superpowers/skills/brainstorming/SKILL.md','superpowers','superpowers@test'),skill('frontend','/project/frontend/SKILL.md')];
 const c=skillSessionSettings('claude',skills,{});
 expect(c.inventory.map(s=>s.mode)).toEqual(['manual','auto']);
 expect(c.config).toEqual({skillOverrides:{},enabledPlugins:{'superpowers@test':false}});
 const x=skillSessionSettings('codex',skills,{brainstorming:'auto',frontend:'disabled'});
 expect(x.config).toEqual({skills:{config:[{path:'/project/frontend/SKILL.md',enabled:false}]}});
 expect(()=>normalizeSkillPolicy({test:'sometimes'})).toThrow();
});
test('mixed Claude plugin policies report the actual visibility limit',()=>{
 const c=skillSessionSettings('claude',[skill('one','/p/one','p','p@m'),skill('two','/p/two','p','p@m')],{one:'disabled'});
 expect(c.limitations).toHaveLength(1);
 expect(c.config).toEqual({skillOverrides:{},enabledPlugins:{}});
});
