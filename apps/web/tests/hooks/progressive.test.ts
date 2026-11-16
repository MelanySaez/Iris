import {it,expect,vi,afterEach} from 'vitest';
const lifecycle=vi.hoisted(()=>({effect:null as null|(()=>void|(()=>void))}));
vi.mock('react',()=>({useEffect:(effect:()=>void)=>{lifecycle.effect=effect;}}));
vi.mock('aladin-lite',()=>({default:{marker:(ra:number,dec:number,options:unknown)=>({ra,dec,options})}}));
import {useTocatsCatalogViewport} from '../../src/hooks/useTocatsCatalogViewport';
import {TocatsViewportCache,chooseTocatsDensityOrder} from '../../src/api/tocats';
function layer(){return {shown:true,show:vi.fn(function(this:any){this.shown=true}),hide:vi.fn(function(this:any){this.shown=false}),remove:vi.fn(),addSources:vi.fn()};}
function setup(){
 vi.useFakeTimers(); vi.stubGlobal('window',{setTimeout,clearTimeout,requestAnimationFrame:(cb:any)=>setTimeout(cb,16),cancelAnimationFrame:clearTimeout});
 const source=layer(),density=layer(), cache=new TocatsViewportCache();
 const client={queryDensity:vi.fn(),query:vi.fn()};
 const refs:any={current:{catalogs:{gaia:source},densityCatalogs:{gaia:density},markers:{gaia:{sources:new Map(),density:new Map()}},caches:{gaia:cache},mode:{gaia:null},requests:{gaia:null},client}};
 const updateState=vi.fn();
 const run=(center:[number,number],fov:number)=>{useTocatsCatalogViewport({catalogId:'gaia',visible:true,aladinReady:true,centerCoords:center,fovWidth:fov,fovHeight:fov,refs,updateState});return lifecycle.effect!();};
 return {source,density,cache,client,refs,updateState,run};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});
it('drills down after zooming a previously loaded wide field',async()=>{
 const s=setup();
 s.cache.mergeDensity({cells:[{id:'gaia:3:1',healpixId:1,order:3,count:10000,ra:5,dec:0,magnitude:null}],foundCells:1,totalSources:10000,truncated:false,order:3});
 s.cache.recordDensityCoverage({raDeg:0,decDeg:0,radiusDeg:90},3);
 s.client.queryDensity.mockResolvedValue({cells:[{id:'gaia:9:1',healpixId:1,order:9,count:1,ra:0,dec:0,magnitude:null}],foundCells:1,totalSources:1,truncated:false,order:9});
 s.client.query.mockResolvedValue({sources:[],columns:{},found:0,truncated:false});
 const clean=s.run([0,0],0.1); await vi.advanceTimersByTimeAsync(900);
 expect(s.client.queryDensity).toHaveBeenCalled();
 if(typeof clean==='function')clean();
});
it('keeps previously loaded individual sources visible after a source HTTP 500',async()=>{
 const s=setup();
 const record={source:{id:'s1',ra:0,dec:0,data:{}},columns:{}};
 s.cache.mergeSources({sources:[record.source],columns:{},found:1,truncated:false});
 s.cache.recordSourceCoverage({raDeg:0,decDeg:0,radiusDeg:0.08});
 s.refs.current.markers.gaia.sources.set('id:s1',{});s.refs.current.mode.gaia='sources';
 const order=chooseTocatsDensityOrder(Math.hypot(.1,.1)*1.25+.02);
 s.client.queryDensity.mockResolvedValue({cells:[{id:`gaia:${order}:1`,healpixId:1,order,count:1,ra:0,dec:0,magnitude:null}],foundCells:1,totalSources:1,truncated:false,order});
 s.client.query.mockRejectedValue(new Error('TOCats returned HTTP 500.'));
 const clean=s.run([0.05,0],0.2);await vi.advanceTimersByTimeAsync(900);
 expect(s.client.query).toHaveBeenCalled();
 expect(s.cache.sources.size).toBe(1);
 expect(s.source.shown).toBe(true);
 if(typeof clean==='function')clean();
});
it('does not allow an obsolete density response to overwrite the newer view',async()=>{
 const s=setup();let resolve:any;
 s.client.queryDensity.mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValueOnce({cells:[],foundCells:0,totalSources:0,truncated:false,order:3});
 const clean=s.run([0,0],180);await vi.advanceTimersByTimeAsync(900);if(typeof clean==='function')clean();
 const clean2=s.run([10,0],180);await vi.advanceTimersByTimeAsync(900);
 resolve({cells:[{id:'stale',healpixId:1,order:3,count:1,ra:0,dec:0,magnitude:null}],foundCells:1,totalSources:1,truncated:false,order:3});await vi.advanceTimersByTimeAsync(20);
 expect(s.cache.cells.has('stale')).toBe(false);if(typeof clean2==='function')clean2();
});
it('queries wide FOV with an order-three bounded child request, never the mother table',async()=>{
 const s=setup();s.client.queryDensity.mockResolvedValue({cells:[],foundCells:0,totalSources:0,truncated:false,order:3});
 const clean=s.run([0,0],180);await vi.advanceTimersByTimeAsync(900);
 expect(s.client.queryDensity).toHaveBeenCalledWith('gaia',{raDeg:0,decDeg:0,radiusDeg:90},3,expect.any(AbortSignal));expect(s.client.query).not.toHaveBeenCalled();if(typeof clean==='function')clean();
});
it('keeps a small source pan inside coverage query-free',async()=>{
 const s=setup();s.cache.mergeSources({sources:[{id:'a',ra:0,dec:0,data:{}}],columns:{},found:1,truncated:false});s.cache.recordSourceCoverage({raDeg:0,decDeg:0,radiusDeg:1});
 const clean=s.run([0.01,0],0.1);await vi.advanceTimersByTimeAsync(900);
 expect(s.client.queryDensity).not.toHaveBeenCalled();expect(s.client.query).not.toHaveBeenCalled();expect(s.source.addSources).toHaveBeenCalled();if(typeof clean==='function')clean();
});
it('retains the old catalog when density HTTP 500 fails',async()=>{
 const s=setup();s.refs.current.mode.gaia='sources';s.client.queryDensity.mockRejectedValue(new Error('TOCats returned HTTP 500.'));
 const clean=s.run([0.05,0],0.2);await vi.advanceTimersByTimeAsync(900);expect(s.source.hide).not.toHaveBeenCalled();expect(s.updateState).toHaveBeenLastCalledWith('gaia',expect.objectContaining({phase:'error'}));if(typeof clean==='function')clean();
});
it('loads individual sources for sparse fresh narrow density and batches nearest-first',async()=>{
 const s=setup(); const radius=Math.hypot(.05,.05),order=chooseTocatsDensityOrder(radius*1.25+.02);
 s.client.queryDensity.mockResolvedValue({cells:[{id:'cell',healpixId:1,order,count:100,ra:0,dec:0,magnitude:null}],foundCells:1,totalSources:100,truncated:false,order});
 s.client.query.mockResolvedValue({sources:Array.from({length:100},(_,i)=>({id:String(i),ra:(99-i)/10000,dec:0,data:{}})),columns:{},found:100,truncated:false});
 const clean=s.run([0,0],.1);await vi.advanceTimersByTimeAsync(851);
 expect(s.source.addSources.mock.calls[0][0]).toHaveLength(50);expect(s.source.addSources.mock.calls[0][0][0].ra).toBe(0);
 await vi.advanceTimersByTimeAsync(50);expect(s.refs.current.markers.gaia.sources.size).toBe(100);expect(s.refs.current.mode.gaia).toBe('sources');if(typeof clean==='function')clean();
});
