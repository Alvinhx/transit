/* NextUp Transit — home.js v6.2 */
/* App logic: station config, fetch, render, update, boot */

// OBA API config — overridden by city JSON at boot
const OBA="https://api.pugetsound.onebusaway.org/api/where";
const KEY="55c7b445-e38b-4da6-ba94-0006a4b3a4bf";
// Dynamic accessors — use these in fetch calls so city config can override
function getOBA(){ return window._OBA_BASE || OBA; }
function getKEY(){ return window._OBA_KEY || KEY; }
// ===== CLASSIFY RULES =====
// Classify functions contain logic so they stay in JS, keyed by classifyRules field in station JSON.
// When adding a new city, add its classify rules here.
const CLASSIFY_RULES = {
  seattle: function(type, agencyId, shortName) {
    if(type===0&&agencyId==="40")return{mode:"rail",tag:"Light Rail",badge:"round"};
    if(type===0&&agencyId==="23")return{mode:"streetcar",tag:(shortName||"").replace(/\s*Streetcar$/i," Streetcar").trim(),badge:"square"};
    if(type===0)return{mode:"streetcar",tag:(shortName||"").replace(/\s*Streetcar$/i," Streetcar").trim(),badge:"square"};
    if(type===2&&agencyId==="96")return{mode:"monorail",tag:"Monorail",badge:"square"};
    if(type===3&&agencyId==="40")return{mode:"express",tag:"ST Express",badge:"square"};
    if(type===3&&(shortName||"").match(/^Swift/i))return{mode:"swift",tag:shortName,badge:"square",isSwift:true};
    if(type===3&&(shortName||"").match(/Line$/i))return{mode:"rapid",tag:"RapidRide",badge:"square"};
    if(agencyId==="29")return{mode:"bus",tag:"Community Transit",badge:"square"};
    return{mode:"bus",tag:"KC Bus",badge:"square"};
  }
};

// ===== STATION CONFIG =====
// Loaded from stations/{city}.json — do not hardcode station data here.
// To add a city: create stations/{city}.json and add classify rules above.

let STATIONS = {};
let _cityConfig = null;

async function loadCityConfig(cityFile) {
  // Clear any cached route data with invalid coordinates (one-time cleanup)
  try {
    const raw = localStorage.getItem('nextup_route_static_cache');
    if (raw) {
      const all = JSON.parse(raw);
      let changed = false;
      for (const routeId in all) {
        const entry = all[routeId];
        const stops = entry?.data?.stops || [];
        if (stops.length > 0 && stops.every(s => s.lat === 0 && s.lon === 0)) {
          delete all[routeId];
          changed = true;
        }
      }
      if (changed) localStorage.setItem('nextup_route_static_cache', JSON.stringify(all));
    }
  } catch (e) {}

  // Version-gate the TransitStore — clear if schema version changed
  // Bump this string whenever the store structure changes incompatibly
  const STORE_VERSION = 'v3';
  try {
    const storedVersion = localStorage.getItem('nextup_transit_store_version');
    if (storedVersion !== STORE_VERSION) {
      localStorage.removeItem('nextup_transit_store');
      localStorage.setItem('nextup_transit_store_version', STORE_VERSION);
    }
  } catch (e) {}

  try {
    const r = await fetch(`stations/${cityFile}.json`);
    if (!r.ok) throw new Error(`Could not load ${cityFile}.json`);
    const cfg = await r.json();
    _cityConfig = cfg;

    // Attach classify functions to each station
    const classifyFn = CLASSIFY_RULES[cfg.classifyRules] || genericClassify;
    STATIONS = {};
    for (const [id, station] of Object.entries(cfg.stations)) {
      STATIONS[id] = { ...station, classify: classifyFn };
    }

    // Update OBA config from city file
    if (cfg.obaApiBase) window._OBA_BASE = cfg.obaApiBase;
    if (cfg.obaApiKey) window._OBA_KEY = cfg.obaApiKey;

    return cfg;
  } catch (e) {
    console.error('Failed to load city config:', e);
    return null;
  }
}

// Resolve location: deferred to boot() after city config loads
let urlParams;
let currentStation;
let currentType;
let CFG;

function handleDeleteLocation(id){
  // Find the location name for the confirmation message
  var customs=loadCustomLocations();
  var loc=null;
  for(var i=0;i<customs.length;i++){if(customs[i].id===id){loc=customs[i];break;}}
  if(!loc) return;

  if(!confirm('Delete "'+loc.name+'"?')) return;

  // Delete from localStorage
  deleteCustomLocation(id);

  // Re-render location menu
  renderLocationMenu();

  // If deleted location was active, switch to caphill
  if(currentType==='custom'&&currentStation===id){
    switchLocation('builtin','caphill');
  }
}

function toggleDefaultLocation(){
  var def=loadDefaultLocation();
  if(def&&def.type===currentType&&def.id===currentStation){
    clearDefaultLocation();
  } else {
    saveDefaultLocation(currentType,currentStation);
  }
  updateHeaderStar();
  renderLocationMenu();
}

var HOME_FILLED='<svg viewBox="0 0 20 21" fill="none"><path d="M19.343 7.661L11.448.556C10.625-.185 9.375-.185 8.552.556L.657 7.661A1.89 1.89 0 000 9.113V19c0 1.105.943 2 2.105 2H7v-9h6v9h4.895c1.162 0 2.105-.895 2.105-2V9.113c0-.55-.238-1.074-.657-1.452z"/></svg>';
var HOME_OUTLINE='<svg viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M1.636 21.58c0 .334.244.605.546.605H7.09v-5.446c0-3.007 2.198-5.446 4.91-5.446 2.71 0 4.909 2.439 4.909 5.446v5.446h4.909c.301 0 .545-.271.545-.605v-8.808c0-.907-.367-1.767-1-2.341L13.727 2.5c-1.005-.912-2.45-.912-3.454 0L2.637 10.43a3.36 3.36 0 00-1 2.341v8.808zM8.727 24H2.182C.977 24 0 22.916 0 21.58v-8.808c0-1.452.587-2.827 1.6-3.747L9.237 1.094C10.844-.365 13.156-.365 14.763 1.094l7.636 7.931C23.413 9.945 24 11.32 24 12.772v8.808C24 22.916 23.023 24 21.818 24h-6.545v-7.261c0-2.005-1.465-3.63-3.273-3.63s-3.273 1.625-3.273 3.63V24z"/></svg>';

function updateHeaderStar(){
  var el=document.getElementById("headerStar");
  var def=loadDefaultLocation();
  var isDefault=def&&def.type===currentType&&def.id===currentStation;
  el.innerHTML=isDefault?HOME_FILLED:HOME_OUTLINE;
  if(isDefault){el.classList.add("is-default");}else{el.classList.remove("is-default");}
}

function setDefaultFromMenu(type,id,event){
  event.stopPropagation();
  var def=loadDefaultLocation();
  if(def&&def.type===type&&def.id===id){
    clearDefaultLocation();
  } else {
    saveDefaultLocation(type,id);
  }
  updateHeaderStar();
  renderLocationMenu();
}

function showCreationModal(){
  document.getElementById("creationModal").style.display="flex";
  document.getElementById("locMenu").classList.remove("open");
  startGeolocation();
}
function closeCreationModal(){
  if(_mapInstance){_mapInstance.remove();_mapInstance=null;}
  _mapMarkers=[];
  _mapSelectedStops={};
  document.getElementById("creationModal").style.display="none";
  document.getElementById("modalBody").innerHTML="";
}

function startGeolocation(){
  var body=document.getElementById("modalBody");

  // If AppState already has location, skip the prompt entirely
  if (typeof AppState !== 'undefined' && AppState.hasLocation) {
    window._addLocCoords={lat:AppState.userLat,lon:AppState.userLon};
    discoverNearbyStops(AppState.userLat, AppState.userLon);
    return;
  }

  body.innerHTML='<div class="modal-spinner"><span class="material-icons">my_location</span><div class="modal-msg">Finding your location...</div></div>';

  if(!navigator.geolocation){
    body.innerHTML='<div class="modal-msg">Your browser doesn\'t support geolocation.</div><div class="modal-actions"><button class="modal-btn" onclick="closeCreationModal()">Cancel</button></div>';
    return;
  }

  // Use AppState.requestLocation so permission is only asked once across the app
  if (typeof AppState !== 'undefined') {
    AppState.requestLocation(
      function(lat, lon) {
        window._addLocCoords={lat:lat,lon:lon};
        discoverNearbyStops(lat, lon);
      },
      function() {
        body.innerHTML='<div class="modal-msg" style="color:var(--text)">📍 Location access is needed to find nearby stops.</div><div class="modal-msg" style="margin-top:8px">Please enable location permissions and try again.</div><div class="modal-actions"><button class="modal-btn" onclick="closeCreationModal()">Cancel</button></div>';
      }
    );
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function(pos){
      // Success — store coords and move to stop discovery (Task 6.3)
      window._addLocCoords={lat:pos.coords.latitude,lon:pos.coords.longitude};
      discoverNearbyStops(pos.coords.latitude, pos.coords.longitude);
    },
    function(err){
      if(err.code===1){
        // Permission denied
        body.innerHTML='<div class="modal-msg" style="color:var(--text)">📍 Location access is needed to find nearby stops.</div><div class="modal-msg" style="margin-top:8px">Please enable location permissions and try again.</div><div class="modal-actions"><button class="modal-btn" onclick="closeCreationModal()">Cancel</button></div>';
      } else {
        // Timeout or other error
        body.innerHTML='<div class="modal-msg" style="color:var(--text)">Couldn\'t determine your location.</div><div class="modal-actions"><button class="modal-btn" onclick="startGeolocation()">Retry</button><button class="modal-btn" onclick="closeCreationModal()">Cancel</button></div>';
      }
    },
    {enableHighAccuracy:true,timeout:10000,maximumAge:60000}
  );
}

async function discoverNearbyStops(lat,lon){
  var body=document.getElementById("modalBody");
  body.innerHTML='<div class="modal-spinner"><span class="material-icons">explore</span><div class="modal-msg">Discovering nearby stops...</div></div>';
  try{
    var r=await fetch(getOBA()+"/stops-for-location.json?key="+getKEY()+"&lat="+lat+"&lon="+lon+"&radius=400");
    if(!r.ok) throw new Error("API error");
    var j=await r.json();
    var routeRefs={};
    for(var rt of (j.data.references.routes||[])) routeRefs[rt.id]=rt;
    var stops=(j.data.list||[]).map(function(s){
      var routeNames=(s.routeIds||[]).map(function(rid){
        var rt=routeRefs[rid];
        return rt?rt.shortName||rt.longName||"":"";
      }).filter(Boolean);
      return{id:s.id,name:s.name,direction:s.direction||"",lat:s.lat,lon:s.lon,routeNames:routeNames};
    });
    if(!stops.length){
      body.innerHTML='<div class="modal-msg" style="color:var(--text)">No transit stops found near your location.</div><div class="modal-actions"><button class="modal-btn" onclick="closeCreationModal()">Cancel</button></div>';
      return;
    }
    window._nearbyStops=stops;
    renderStopSelector(stops);
  }catch(e){
    body.innerHTML='<div class="modal-msg" style="color:var(--text)">Couldn\'t load nearby stops.</div><div class="modal-actions"><button class="modal-btn" onclick="discoverNearbyStops('+lat+','+lon+')">Retry</button><button class="modal-btn" onclick="closeCreationModal()">Cancel</button></div>';
  }
}

var _mapSelectedStops={};
var _mapInstance=null;
var _mapMarkers=[];
var _mapInitialCenter=null;

function renderStopSelector(stops){
  var body=document.getElementById("modalBody");
  var defaultName=suggestDefaultName(stops);
  // All stops selected by default
  _mapSelectedStops={};
  for(var i=0;i<stops.length;i++) _mapSelectedStops[stops[i].id]=true;

  var html='<label class="modal-label">Location Name</label>';
  html+='<input type="text" class="modal-input" id="locNameInput" maxlength="40" value="'+defaultName.replace(/"/g,'&quot;')+'" placeholder="e.g. My Stop">';
  html+='<div id="nameError" class="modal-error" style="display:none"></div>';
  html+='<label class="modal-label" style="margin-top:16px">Tap stops to select/deselect</label>';
  html+='<div class="map-counter" id="mapCounter">'+stops.length+' of '+stops.length+' stops selected</div>';
  html+='<div style="position:relative"><div id="stopMap"></div><button class="map-rescan" id="mapRescan" onclick="rescanArea()">Scan this area</button></div>';
  html+='<div id="stopError" class="modal-error" style="display:none"></div>';
  html+='<div class="modal-actions">';
  html+='<button class="modal-btn" onclick="closeCreationModal()">Cancel</button>';
  html+='<button class="modal-btn primary" onclick="handleSaveClick()">Save Location</button>';
  html+='</div>';
  body.innerHTML=html;

  // Init Leaflet map
  var coords=window._addLocCoords;
  var map=L.map('stopMap',{zoomControl:true,attributionControl:false}).setView([coords.lat,coords.lon],16);
  _mapInstance=map;
  L.tileLayer(AppState.getMapTileUrl(),{maxZoom:19}).addTo(map);

  // User location marker (blue dot)
  L.circleMarker([coords.lat,coords.lon],{radius:8,color:'#3b82f6',fillColor:'#3b82f6',fillOpacity:0.9,weight:2}).addTo(map).bindPopup('You are here');

  // Stop markers
  _mapMarkers=[];
  var bounds=L.latLngBounds([[coords.lat,coords.lon]]);
  for(var j=0;j<stops.length;j++){
    (function(s){
      var selected=true;
      var marker=L.circleMarker([s.lat,s.lon],{
        radius:10,color:'#22c55e',fillColor:'#22c55e',fillOpacity:0.8,weight:2
      }).addTo(map);
      var dirLabel=s.direction?{N:'NB',S:'SB',E:'EB',W:'WB',NE:'NE',NW:'NW',SE:'SE',SW:'SW'}[s.direction]||s.direction:'';
      var routeStr=s.routeNames.length?'<br>Routes: '+s.routeNames.join(', '):'';
      marker.bindPopup('<b>'+s.name+'</b>'+(dirLabel?' · '+dirLabel:'')+routeStr,{className:'dark-popup'});
      marker.on('click',function(){
        selected=!selected;
        _mapSelectedStops[s.id]=selected;
        marker.setStyle({color:selected?'#22c55e':'#555',fillColor:selected?'#22c55e':'#555',fillOpacity:selected?0.8:0.4});
        updateMapCounter(stops.length);
      });
      bounds.extend([s.lat,s.lon]);
      _mapMarkers.push({marker:marker,stop:s});
    })(stops[j]);
  }
  map.fitBounds(bounds,{padding:[30,30]});
  // Fix Leaflet rendering in modal (tiles may not load until resize)
  setTimeout(function(){map.invalidateSize();},200);
  // Show "Scan this area" button when user pans the map
  var _initialCenter=map.getCenter();
  _mapInitialCenter=_initialCenter;
  map.on('moveend',function(){
    var c=map.getCenter();
    var dist=c.distanceTo(_mapInitialCenter);
    var btn=document.getElementById("mapRescan");
    if(btn) btn.style.display=dist>100?"block":"none";
  });
}

async function rescanArea(){
  if(!_mapInstance) return;
  var center=_mapInstance.getCenter();
  var lat=center.lat,lon=center.lng;
  window._addLocCoords={lat:lat,lon:lon};
  var btn=document.getElementById("mapRescan");
  if(btn){btn.textContent="Scanning...";btn.disabled=true;}
  try{
    var r=await fetch(getOBA()+"/stops-for-location.json?key="+getKEY()+"&lat="+lat+"&lon="+lon+"&radius=400");
    if(!r.ok) throw new Error("API error");
    var j=await r.json();
    var routeRefs={};
    for(var rt of (j.data.references.routes||[])) routeRefs[rt.id]=rt;
    var stops=(j.data.list||[]).map(function(s){
      var routeNames=(s.routeIds||[]).map(function(rid){
        var rt=routeRefs[rid];
        return rt?rt.shortName||rt.longName||"":"";
      }).filter(Boolean);
      return{id:s.id,name:s.name,direction:s.direction||"",lat:s.lat,lon:s.lon,routeNames:routeNames};
    });
    // Clear old markers
    _mapMarkers.forEach(function(m){_mapInstance.removeLayer(m.marker);});
    _mapMarkers=[];
    _mapSelectedStops={};
    // Add new markers
    for(var i=0;i<stops.length;i++) _mapSelectedStops[stops[i].id]=true;
    for(var j2=0;j2<stops.length;j2++){
      (function(s){
        var selected=true;
        var marker=L.circleMarker([s.lat,s.lon],{
          radius:10,color:'#22c55e',fillColor:'#22c55e',fillOpacity:0.8,weight:2
        }).addTo(_mapInstance);
        var dirLabel=s.direction?{N:'NB',S:'SB',E:'EB',W:'WB',NE:'NE',NW:'NW',SE:'SE',SW:'SW'}[s.direction]||s.direction:'';
        var routeStr=s.routeNames.length?'<br>Routes: '+s.routeNames.join(', '):'';
        marker.bindPopup('<b>'+s.name+'</b>'+(dirLabel?' · '+dirLabel:'')+routeStr,{className:'dark-popup'});
        marker.on('click',function(){
          selected=!selected;
          _mapSelectedStops[s.id]=selected;
          marker.setStyle({color:selected?'#22c55e':'#555',fillColor:selected?'#22c55e':'#555',fillOpacity:selected?0.8:0.4});
          updateMapCounter(stops.length);
        });
        _mapMarkers.push({marker:marker,stop:s});
      })(stops[j2]);
    }
    window._nearbyStops=stops;
    // Update counter and name suggestion
    updateMapCounter(stops.length);
    var nameInput=document.getElementById("locNameInput");
    if(nameInput&&!nameInput.dataset.userEdited){
      nameInput.value=suggestDefaultName(stops);
    }
    // Hide rescan button and update initial center
    if(btn){btn.style.display="none";btn.textContent="Scan this area";btn.disabled=false;}
    _mapInitialCenter=_mapInstance.getCenter();
  }catch(e){
    if(btn){btn.textContent="Scan this area";btn.disabled=false;}
  }
}

function updateMapCounter(total){
  var count=0;
  for(var k in _mapSelectedStops) if(_mapSelectedStops[k]) count++;
  var el=document.getElementById("mapCounter");
  if(el) el.textContent=count+' of '+total+' stops selected';
}

function handleSaveClick(){
  // Validate name
  var nameInput=document.getElementById("locNameInput");
  var name=nameInput.value.trim();
  var nameResult=validateLocationName(name);
  var nameErr=document.getElementById("nameError");
  if(!nameResult.valid){
    nameErr.textContent=nameResult.error;
    nameErr.style.display="block";
    nameInput.focus();
    return;
  }
  nameErr.style.display="none";

  // Collect selected stop IDs from map state
  var selectedIds=[];
  for(var k in _mapSelectedStops){if(_mapSelectedStops[k]) selectedIds.push(k);}
  var stopErr=document.getElementById("stopError");
  if(!selectedIds.length){
    stopErr.textContent="Select at least one stop.";
    stopErr.style.display="block";
    return;
  }
  stopErr.style.display="none";

  handleSaveLocation(name, selectedIds);
}

function handleSaveLocation(name, selectedIds){
  var coords=window._addLocCoords;
  if(!coords){
    document.getElementById("stopError").textContent="Location data lost. Please try again.";
    document.getElementById("stopError").style.display="block";
    return;
  }

  var newLoc={
    id:generateLocationId(),
    name:name,
    lat:coords.lat,
    lon:coords.lon,
    stopIds:selectedIds,
    createdAt:Date.now()
  };

  var existing=loadCustomLocations();
  existing.push(newLoc);
  var saved=saveCustomLocations(existing);

  if(!saved){
    document.getElementById("stopError").textContent="Couldn't save location. Your browser may not support local storage or storage is full.";
    document.getElementById("stopError").style.display="block";
    return;
  }

  // Clean up temp data
  delete window._addLocCoords;
  delete window._nearbyStops;

  // Close modal and switch to the new location
  closeCreationModal();
  switchLocation('custom', newLoc.id);
}

function renderLocationMenu(){
  var menu=document.getElementById("locMenu");
  menu.innerHTML="";
  var customs=loadCustomLocations();
  var hasCustom=customs.length>0;
  var def=loadDefaultLocation();

  // Top row: Add Location button
  var topRow=document.createElement("div");
  topRow.className="loc-menu-top";
  var addBtn=document.createElement("a");
  addBtn.className="loc-item loc-add";
  addBtn.innerHTML='<span class="material-icons" style="font-size:18px">add_circle_outline</span> Add Location';
  addBtn.onclick=function(){showCreationModal();};
  topRow.appendChild(addBtn);
  menu.appendChild(topRow);

  // Columns container
  var cols=document.createElement("div");
  cols.className="loc-menu-columns";

  // Left column: Pre-set
  var leftCol=document.createElement("div");
  leftCol.className="loc-menu-col";
  var preTitle=document.createElement("div");
  preTitle.className="loc-section-title";
  preTitle.textContent="Pre-set";
  leftCol.appendChild(preTitle);
  var builtinKeys=Object.keys(STATIONS);
  for(var i=0;i<builtinKeys.length;i++){
    var key=builtinKeys[i];
    var a=document.createElement("a");
    a.className="loc-item"+(currentType==="builtin"&&currentStation===key?" active":"");
    a.style.cssText="display:flex;align-items:center;gap:8px";
    var isDef=def&&def.type==="builtin"&&def.id===key;
    var home=document.createElement("span");
    home.className="loc-home"+(isDef?" is-default":"");
    home.innerHTML=isDef?HOME_FILLED:HOME_OUTLINE;
    (function(k){
      home.onclick=function(e){setDefaultFromMenu("builtin",k,e);};
      a.onclick=function(){switchLocation("builtin",k);};
    })(key);
    a.appendChild(home);
    var nameSpan=document.createElement("span");
    nameSpan.textContent=STATIONS[key].name;
    a.appendChild(nameSpan);
    leftCol.appendChild(a);
  }
  cols.appendChild(leftCol);

  // Right column: Custom (only if custom locations exist)
  if(hasCustom){
    var rightCol=document.createElement("div");
    rightCol.className="loc-menu-col";
    var cusTitle=document.createElement("div");
    cusTitle.className="loc-section-title";
    cusTitle.textContent="Custom";
    rightCol.appendChild(cusTitle);
    for(var j=0;j<customs.length;j++){
      var cl=customs[j];
      var item=document.createElement("a");
      item.className="loc-item loc-custom"+(currentType==="custom"&&currentStation===cl.id?" active":"");
      var isDefC=def&&def.type==="custom"&&def.id===cl.id;
      var homeC=document.createElement("span");
      homeC.className="loc-home"+(isDefC?" is-default":"");
      homeC.innerHTML=isDefC?HOME_FILLED:HOME_OUTLINE;
      (function(cid){
        homeC.onclick=function(e){setDefaultFromMenu("custom",cid,e);};
      })(cl.id);
      item.appendChild(homeC);
      var nameSpan=document.createElement("span");
      nameSpan.className="loc-custom-name";
      nameSpan.textContent=cl.name;
      item.appendChild(nameSpan);
      var del=document.createElement("span");
      del.className="material-icons loc-delete";
      del.textContent="close";
      (function(cid){
        del.onclick=function(event){event.stopPropagation();handleDeleteLocation(cid);};
        item.onclick=function(){switchLocation("custom",cid);};
      })(cl.id);
      item.appendChild(del);
      rightCol.appendChild(item);
    }
    cols.appendChild(rightCol);
  }

  menu.appendChild(cols);
}

function switchLocation(type,id){
  _locationGeneration++;
  currentType=type;
  currentStation=id;
  const fallback = (_cityConfig && _cityConfig.defaultStation) || 'caphill';
  if(type==='builtin'){
    CFG=STATIONS[id]||STATIONS[fallback];
  } else if(type==='custom'){
    var cls=loadCustomLocations();
    var found=null;
    for(var i=0;i<cls.length;i++){if(cls[i].id===id){found=cls[i];break;}}
    if(found){CFG=buildCustomConfig(found,genericClassify);}
    else{CFG=STATIONS[fallback];currentType='builtin';currentStation=fallback;}
  }
  for(var k in routeCache) delete routeCache[k];
  for(var dk in _directionMap) delete _directionMap[dk];
  cache.length=0;
  document.getElementById("stationName").textContent=CFG.name;
  saveActiveLocation(currentType,currentStation);
  renderLocationMenu();
  updateHeaderStar();
  document.getElementById("locMenu").classList.remove("open");
  // 3-phase boot for new location
  showManifest();
  if(!cache.length) document.getElementById("results").innerHTML='<div class="loading">Loading…</div>';
  (async function(){
    await loadScheduleETAs();
    await update();
    applyNextDayFromSchedule();
    if(refreshInterval) clearInterval(refreshInterval);
    refreshInterval=setInterval(animatedUpdate,15000);
    // Populate TransitStore for new location in background
    const _switchGen = _locationGeneration;
    setTimeout(() => populateRouteStore(_switchGen), 2000);
  })();
}

var _locationGeneration=0; // incremented on every location switch to cancel stale fetches
function getAllStopIds(){return Object.values(CFG.stops).flat();}

// Station name + header star are set in boot() after CFG is loaded

// Route number parser
function parseRoute(shortName,routeType,agencyId){
  return shortName.replace(/\s*Line$/i,"").replace(/\s*Streetcar$/i,"").trim();
}

// classify uses current station config
function classify(type,agencyId,shortName){
  return CFG.classify(type,agencyId,shortName);
}

async function fetchStop(id){
  const r=await fetch(`${getOBA()}/arrivals-and-departures-for-stop/${id}.json?key=${getKEY()}&minutesBefore=0&minutesAfter=60`);
  if(r.status===429){
    // Rate limited — return empty, existing cache will be used
    return[];
  }
  if(!r.ok)return[];
  const j=await r.json();
  const routes={};for(const rt of j.data.references.routes||[])routes[rt.id]=rt;
  return j.data.entry.arrivalsAndDepartures.map(a=>{
    const rt=routes[a.routeId]||{};
    const pred=a.predictedDepartureTime||a.predictedArrivalTime;
    const sched=a.scheduledDepartureTime||a.scheduledArrivalTime;
    const live=pred>0;
    const cls=classify(rt.type,rt.agencyId,rt.shortName||"");
    return{
      route:parseRoute(rt.shortName||"?",rt.type,rt.agencyId),
      routeId:a.routeId,
      headsign:a.tripHeadsign||rt.longName||"",
      ms:live?pred:sched,live,
      color:rt.color?`#${rt.color}`:"#666",
      textColor:rt.textColor?`#${rt.textColor}`:"#fff",
      ...cls,
    };
  });
}

// Track which route keys received new data in the current refresh cycle
var _routesUpdatedThisCycle=new Set();

// Direction map: maps "route|mode" -> [headsign0, headsign1]
// Built from schedule data, used to resolve live headsigns to direction index 0 or 1
var _directionMap={};

// Resolve a headsign to a direction index (0 or 1) using the direction map
function resolveDir(route,mode,headsign){
  var mapKey=route+"|"+mode;
  var dirs=_directionMap[mapKey];
  if(!dirs||!dirs.length) {
    // No map yet — create entry with this as direction 0
    _directionMap[mapKey]=[headsign];
    return 0;
  }
  // Check if headsign matches an existing direction (first-word comparison)
  var hw=normalizeDirKey(headsign);
  for(var i=0;i<dirs.length;i++){
    if(normalizeDirKey(dirs[i])===hw) return i;
  }
  // New direction — add it (max 2)
  if(dirs.length<2){
    dirs.push(headsign);
    return dirs.length-1;
  }
  // Already have 2 directions, pick closest match (shouldn't happen often)
  return 0;
}

// Merge a single stop's arrivals into routeCache
function mergeStopData(departures){
  for(const d of departures){
    const di=resolveDir(d.route,d.mode,d.headsign);
    const k=d.route+"|"+d.mode+"|"+di;
    // Track that this route received new data this cycle
    _routesUpdatedThisCycle.add(k);
    if(!routeCache[k]){
      routeCache[k]={...d,etas:[{ms:d.ms,live:d.live}],missedCycles:0};
    } else {
      routeCache[k].missedCycles=0;
      // On first new data for this route in this cycle, strip old live ETAs (fetch-then-replace)
      if(!routeCache[k]._liveReplacedThisCycle){
        routeCache[k].etas=routeCache[k].etas.filter(e=>!e.live);
        routeCache[k]._liveReplacedThisCycle=true;
      }
      // If live, replace any scheduled ETA within 3 min of this one
      if(d.live){
        routeCache[k].etas=routeCache[k].etas.filter(e=>{
          if(!e.live&&Math.abs(e.ms-d.ms)<180000) return false;
          return true;
        });
        routeCache[k].etas.push({ms:d.ms,live:d.live});
      } else {
        // Don't add scheduled if a live ETA is already within 3 min
        const hasLiveNearby=routeCache[k].etas.some(e=>e.live&&Math.abs(e.ms-d.ms)<180000);
        if(!hasLiveNearby){
          routeCache[k].etas.push({ms:d.ms,live:d.live});
        }
      }
      // Lock headsign: first live feed sets the short destination name, then it never changes again
      if(d.headsign&&!routeCache[k]._headsignLocked){
        routeCache[k].headsign=d.headsign;
        if(d.live) routeCache[k]._headsignLocked=true;
      }
      // Dedupe by exact ms+live, sort, cap at 3
      const seen=new Set();
      routeCache[k].etas=routeCache[k].etas.filter(e=>{const key=e.ms+"|"+e.live;if(seen.has(key))return false;seen.add(key);return true;});
      routeCache[k].etas.sort((a,b)=>a.ms-b.ms);
      routeCache[k].etas=routeCache[k].etas.slice(0,3);
    }
  }
}

function renderFromCache(){
  if (_suppressRender) return; // animatedUpdate will do the final render
  const now=Date.now();
  // Fallback: if a route has no ETAs but has scheduleTimes, generate ETAs from schedule
  for(const k in routeCache){
    const entry=routeCache[k];
    if((!entry.etas||!entry.etas.length)&&entry.scheduleTimes&&entry.scheduleTimes.length){
      const upcoming=entry.scheduleTimes.filter(t=>t>now);
      if(upcoming.length){
        entry.etas=upcoming.slice(0,3).map(t=>({ms:t,live:false}));
      }
    }
  }
  const sorted=Object.values(routeCache).sort(prioritySort);
  cache.length=0;cache.push(...sorted);
  const el=document.getElementById("results");
  el.innerHTML=cache.map(renderCard).join("");
  attachLongPress();
}

function etaText(ms){const m=Math.round((ms-Date.now())/60000);return m<=0?"NOW":`${m}`;}

// Compute next-day first departure from the schedule timetable (no API call needed).
// The allScheduleTimes array has all times for today. The first time in the array
// is approximately when service starts. Adding ~24h gives tomorrow's first departure.
function applyNextDayFromSchedule(){
  var now=Date.now();
  for(var k in routeCache){
    var entry=routeCache[k];
    // Only apply to routes with no current ETAs and no nextDayTimes already set
    if(entry.etas&&entry.etas.length) continue;
    if(entry.nextDayTimes) continue;
    // Need allScheduleTimes to compute next day
    if(!entry.allScheduleTimes||!entry.allScheduleTimes.length) continue;
    // Check if service has ended (all times in the past)
    var upcoming=entry.allScheduleTimes.filter(function(t){return t>now;});
    if(upcoming.length>0) continue; // still has upcoming service today
    // Service ended — compute tomorrow's first departure from today's first time + 24h
    var sorted=entry.allScheduleTimes.slice().sort(function(a,b){return a-b;});
    var firstToday=sorted[0];
    var oneDayMs=24*60*60*1000;
    // Tomorrow's first departure ≈ today's first departure + 24h
    entry.nextDayTimes=[firstToday+oneDayMs];
  }
  renderFromCache();
}

function formatTime(ms){
  const d=new Date(ms);
  return d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});
}

function renderPill(eta,idx){
  const mins=Math.round((eta.ms-Date.now())/60000);
  if(mins<-1)return"";
  // Live + due now: neon green NOW capsule
  if(mins<=0&&eta.live)return`<div class="pill now"><span class="pill-num">NOW</span></div>`;
  // Scheduled + due now: grey "0"
  if(mins<=0&&!eta.live)return`<div class="pill sched"><span class="pill-num">0</span><span class="pill-min">min</span></div>`;
  // Urgency class based on position
  const urgClass=eta.live?(idx===0?"live-near":"live-far"):"sched";
  const liveIcon=eta.live?`<span class="pill-live"><svg class="sig-0 dark-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><mask id="dm03" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="3" y="4" width="17" height="17"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#1C1B1F"/></mask><g mask="url(#dm03)"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#8B949E"/><circle cx="5" cy="19" r="2" fill="#22C55E"/></g></svg><svg class="sig-1 dark-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><mask id="dm02" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="3" y="4" width="17" height="17"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#1C1B1F"/></mask><g mask="url(#dm02)"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#8B949E"/><circle cx="3" cy="21" r="11" fill="#22C55E"/></g></svg><svg class="sig-2 dark-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><mask id="dm01" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="3" y="4" width="17" height="17"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#1C1B1F"/></mask><g mask="url(#dm01)"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#22C55E"/><circle cx="3" cy="21" r="17" fill="#22C55E"/></g></svg><svg class="sig-0 light-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><mask id="lm03" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="3" y="4" width="17" height="17"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#1C1B1F"/></mask><g mask="url(#lm03)"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#64748B"/><circle cx="5" cy="19" r="2" fill="#16A34A"/></g></svg><svg class="sig-1 light-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><mask id="lm02" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="3" y="4" width="17" height="17"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#1C1B1F"/></mask><g mask="url(#lm02)"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#64748B"/><circle cx="3" cy="21" r="11" fill="#16A34A"/></g></svg><svg class="sig-2 light-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><mask id="lm01" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="3" y="4" width="17" height="17"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#1C1B1F"/></mask><g mask="url(#lm01)"><path d="M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z" fill="#16A34A"/><circle cx="3" cy="21" r="17" fill="#16A34A"/></g></svg></span>`:"";
  return`<div class="pill ${urgClass}">${liveIcon}<span class="pill-num">${mins}</span><span class="pill-min">min</span></div>`;
}

function renderCard(g){
  const isIcon=g.badge==="square"&&(g.mode==="streetcar"||g.mode==="monorail"||g.mode==="swift");
  const numClass=g.route.length>2?"sm":"";
  const isRail=g.mode==="rail";
  const badgeInner=isIcon
    ?`<span class="badge-icon">${g.mode==="monorail"?"train":g.mode==="swift"?"directions_bus":"tram"}</span>`
    :`<span class="badge-num ${numClass}" style="color:${g.textColor}">${g.route}</span>${isRail?'<span class="badge-sub">LINE</span>':''}`;
  // If nextDayTimes set, or if nearest ETA is >90 min away, show as clock time
  // Filter out individual ETAs >90 min when there are closer ones
  var pills;
  if(g.nextDayTimes){
    pills=`<div class="next-day-times"><span>${formatTime(g.nextDayTimes[0])}</span></div>`;
  } else if(g.etas.length){
    var nearestMin=Math.round((g.etas[0].ms-Date.now())/60000);
    if(nearestMin>90){
      pills=`<div class="next-day-times"><span>${formatTime(g.etas[0].ms)}</span></div>`;
    } else {
      var relevantEtas=g.etas.filter(function(eta){return Math.round((eta.ms-Date.now())/60000)<=90;});
      if(!relevantEtas.length) relevantEtas=[g.etas[0]];
      pills=relevantEtas.map((eta,i)=>renderPill(eta,i)).join("");
    }
  } else {
    pills=`<div class="pill sched"><span class="pill-num" style="font-size:18px;color:var(--dim)">···</span></div>`;
  }
  const cardKey=g.route+"|"+g.headsign+"|"+g.mode;
  const isPinned=isRoutePinned(cardKey,g.route);
  const pinHtml=isPinned?'<span class="card-pin"><svg viewBox="0 0 24 24"><path d="M20 15.31L23.31 12 20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69z"/></svg></span>':'';
  const pinnedClass=isPinned?' pinned':'';
  // M3 Tonal palette colors per route
  const TONES={
    "#3DAE2B":{dark:{card:"#0E280A",tagBg:"#2B7A1E",tagTxt:"#B5EAAD"},light:{card:"#DAF4D6",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#2B7A1E"}},
    "#00A0DF":{dark:{card:"#002433",tagBg:"#006D99",tagTxt:"#99E2FF"},light:{card:"#CCF0FE",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#006D99"}},
    "#FDB71A":{dark:{card:"#1a1712",tagBg:"#7e5c0d",tagTxt:"#ffe500"},light:{card:"#ffefcd",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#be8914"}},
    "#9C182F":{dark:{card:"#1a1214",tagBg:"#4e0b17",tagTxt:"#fd3154"},light:{card:"#e9ccd1",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#751122"}},
    "#2B376E":{dark:{card:"#12141f",tagBg:"#161c37",tagTxt:"#7083d7"},light:{card:"#cdd2ee",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#132686"}},
    "#E5007D":{dark:{card:"#1a0f14",tagBg:"#72003e",tagTxt:"#ff00be"},light:{card:"#f9c7e2",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#ac005e"}},
    "#F47836":{dark:{card:"#1f140d",tagBg:"#7a3c1b",tagTxt:"#ffb088"},light:{card:"#fde8d8",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#b25619"}},
    "#666672":{dark:{card:"#141417",tagBg:"#333339",tagTxt:"#9090a4"},light:{card:"#dddde0",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#4d4d56"}},
    "#F24C21":{dark:{card:"#1a140f",tagBg:"#773911",tagTxt:"#ffa427"},light:{card:"#fbe0ce",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#b25619"}},
    "#006CFF":{dark:{card:"#0f141f",tagBg:"#003680",tagTxt:"#00a1ff"},light:{card:"#c7dfff",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#0051bf"}},
    "#0070C0":{dark:{card:"#0f141f",tagBg:"#003680",tagTxt:"#00a1ff"},light:{card:"#c7dfff",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#0051bf"}}
  };
  const isLight=document.body.classList.contains("light");
  const tone=TONES[g.color];
  const theme=isLight?"light":"dark";
  const cardBg=tone?tone[theme].card:(isLight?`rgba(200,200,200,0.3)`:`rgba(255,255,255,0.08)`);
  const tagBg=tone?tone[theme].tagBg:(isLight?"rgba(255,255,255,0.7)":"rgba(255,255,255,0.06)");
  const tagColor=tone?tone[theme].tagTxt:(isLight?"#333":"#aaa");
  return`<div class="card${pinnedClass}" data-key="${cardKey}" data-route="${g.route}" style="background:${cardBg}">
    ${pinHtml}
    <div class="badge ${g.badge}" style="background:${g.color}">
      ${badgeInner}
    </div>
    <div class="info">
      <div class="tag" style="background:${tagBg};color:${tagColor}">${g.tag}</div>
      <div class="dest">${g.headsign}</div>
    </div>
    <div class="etas">${pills}</div>
  </div>`;
}

// Check if a card is pinned. User overrides use cardKey (per-direction).
// Pre-set defaults use route name (both directions).
function isRoutePinned(cardKey,routeName){
  var override=loadPriorityOverride(currentStation);
  if(override!==null){
    // User has overrides — check by cardKey only
    return override.indexOf(cardKey)>=0;
  }
  // No override — use pre-set defaults (match by route name)
  return CFG.priority.indexOf(routeName)>=0;
}

function prioritySort(a,b){
  var aKey=a.route+"|"+a.headsign+"|"+a.mode;
  var bKey=b.route+"|"+b.headsign+"|"+b.mode;
  var aPinned=isRoutePinned(aKey,a.route)?0:1;
  var bPinned=isRoutePinned(bKey,b.route)?0:1;
  if(aPinned!==bPinned)return aPinned-bPinned;
  return(a.etas[0]?.ms||Infinity)-(b.etas[0]?.ms||Infinity);
}

const cache=[];
const routeCache={}; // keyed by route+direction, persists between refreshes
// Wire LiveCache to routeCache so the data layer can read it
if (typeof LiveCache !== 'undefined') LiveCache.init(routeCache);

// Long-press to toggle priority (500ms hold)
var _lpTimer=null;
var _lpFired=false;
function attachLongPress(){
  document.querySelectorAll(".card[data-route]").forEach(function(card){
    var _touchStartY = 0;
    var _touchMoved = false;
    function startPress(e){
      _lpFired=false;
      _touchMoved=false;
      if(e.touches) _touchStartY = e.touches[0].clientY;
      var el=card;
      _lpTimer=setTimeout(function(){
        if(_touchMoved) return; // finger moved — don't fire long-press
        _lpFired=true;
        if(navigator.vibrate) navigator.vibrate(30);
        togglePriority(el);
      },500);
    }
    function endPress(){clearTimeout(_lpTimer);}
    function cancelPress(){clearTimeout(_lpTimer); _touchMoved=true;}
    var _touchHandled = false;
    card.addEventListener("touchstart",function(e){startPress(e);},{passive:true});
    card.addEventListener("touchend",function(e){
      var wasFired=_lpFired;
      endPress();
      // If finger moved (scroll), don't fire tap
      if(_touchMoved) return;
      // Short tap (not long-press) → open detail
      if(!wasFired){
        _touchHandled = true;
        setTimeout(function(){ _touchHandled = false; }, 500);
        var key=card.getAttribute("data-key");
        var g=cache.find(function(c){return(c.route+"|"+c.headsign+"|"+c.mode)===key;});
        if(g&&typeof openRouteDetail==="function") openRouteDetail(g);
      }
    });
    card.addEventListener("touchmove",function(e){
      // If finger moved more than 10px vertically, it's a scroll
      if(e.touches && Math.abs(e.touches[0].clientY - _touchStartY) > 10){
        _touchMoved=true;
        clearTimeout(_lpTimer);
      }
    },{passive:true});
    card.addEventListener("touchcancel",cancelPress);
    card.addEventListener("mousedown",startPress);
    card.addEventListener("mouseleave",cancelPress);
    card.addEventListener("click",function(){
      if(_lpFired) return;
      if(_touchHandled) return;
      var key=card.getAttribute("data-key");
      var g=cache.find(function(c){return(c.route+"|"+c.headsign+"|"+c.mode)===key;});
      if(g&&typeof openRouteDetail==="function") openRouteDetail(g);
    });
    card.addEventListener("contextmenu",function(e){e.preventDefault();});
  });
}

function togglePriority(cardEl){
  var cardKey=cardEl.getAttribute("data-key");
  if(!cardKey)return;
  // Load or initialize override from current state
  var override=loadPriorityOverride(currentStation);
  var pri;
  if(override!==null){
    pri=override.slice();
  } else {
    // First user override — convert pre-set defaults to cardKey format
    // by checking which current cards match the default route names
    pri=[];
    for(var i=0;i<cache.length;i++){
      var g=cache[i];
      if(CFG.priority.indexOf(g.route)>=0){
        pri.push(g.route+"|"+g.headsign+"|"+g.mode);
      }
    }
  }
  var idx=pri.indexOf(cardKey);
  if(idx>=0){pri.splice(idx,1);}else{pri.push(cardKey);}
  savePriorityOverride(currentStation,pri);
  // Re-render cards with updated priority
  var el=document.getElementById("results");
  cache.sort(prioritySort);
  el.innerHTML=cache.map(renderCard).join("");
  attachLongPress();
}

async function update(){
  var gen=_locationGeneration;
  document.getElementById("updated").textContent="Updating...";
  const ids=getAllStopIds();
  let completed=0;
  const total=ids.length;
  // Clear the per-cycle tracking set and per-route replacement flags
  _routesUpdatedThisCycle.clear();
  for(const k in routeCache){ delete routeCache[k]._liveReplacedThisCycle; }
  // Fire fetches with a small stagger (500ms between each) to avoid rate limiting
  // 7 stops × 500ms = 3.5s total spread, well within the 30s refresh cycle
  const promises=ids.map(async (id, idx)=>{
    await new Promise(r=>setTimeout(r, idx * 1000)); // stagger: 0ms, 500ms, 1000ms...
    try{
      const deps=await fetchStop(id);
      if(gen!==_locationGeneration) return; // stale — discard
      if(deps.length){
        mergeStopData(deps);
        renderFromCache(); // render progressively as each stop arrives
      }
    }catch(e){}
    completed++;
    if(gen===_locationGeneration) document.getElementById("updated").textContent=`Updating... ${completed}/${total}`;
  });
  await Promise.all(promises);
  if(gen!==_locationGeneration) return; // location changed while fetching — abort
  // Clean up per-route replacement flags
  for(const k in routeCache){ delete routeCache[k]._liveReplacedThisCycle; }
  // Missed-cycle tracking for graceful degradation from live to scheduled ETAs
  for(const k in routeCache){
    const entry=routeCache[k];
    if(_routesUpdatedThisCycle.has(k)){
      entry.missedCycles=0;
    } else if(entry.etas&&entry.etas.some(e=>e.live)){
      entry.missedCycles=(entry.missedCycles||0)+1;
      // After 6 missed cycles (~90s at 15s intervals), degrade to schedule
      if(entry.missedCycles>=6&&entry.scheduleTimes&&entry.scheduleTimes.length){
        const now2=Date.now();
        const upcoming=entry.scheduleTimes.filter(t=>t>now2);
        if(upcoming.length){
          entry.etas=upcoming.slice(0,3).map(t=>({ms:t,live:false}));
        }
        entry.missedCycles=0;
      }
    }
  }
  renderFromCache();
  // Clean up expired ETAs (but never delete routes — append-only)
  const now=Date.now();
  for(const k in routeCache){
    const g=routeCache[k];
    if(g.etas&&g.etas.length){
      g.etas=g.etas.filter(e=>e.ms>now-60000);
      // Don't delete the route or its metadata — renderFromCache() will fall back to scheduleTimes
    }
  }
  renderFromCache();
  document.getElementById("updated").textContent=`v6.2-${typeof VERSION!=='undefined'?VERSION:'?'} · Updated ${new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}`;
  document.getElementById("dot").classList.remove("error");
}

var _suppressRender = false; // unused — kept for compatibility

function animatedUpdate(){
  // Skip animation if detail panel is open — prevents cards from flipping while user is in detail view
  if (typeof _detailOpen !== 'undefined' && _detailOpen) {
    update();
    return;
  }
  const el=document.getElementById("results");
  // FLIP: record old positions before update starts
  const oldCards={};
  el.querySelectorAll(".card").forEach(c=>{
    const key=c.dataset.key;
    if(key)oldCards[key]=c.getBoundingClientRect();
  });
  // Run update — progressive renders happen normally during update
  update().then(()=>{
    // FLIP: animate cards that moved position
    el.querySelectorAll(".card").forEach(c=>{
      const key=c.dataset.key;
      if(!key||!oldCards[key])return;
      const oldRect=oldCards[key];
      const newRect=c.getBoundingClientRect();
      const dx=oldRect.left-newRect.left;
      const dy=oldRect.top-newRect.top;
      if(Math.abs(dx)<1&&Math.abs(dy)<1)return;
      c.style.transition="none";
      c.style.transform=`translate(${dx}px,${dy}px)`;
      requestAnimationFrame(()=>{
        c.style.transition="transform 0.4s ease";
        c.style.transform="";
      });
    });
  });
}

function tick(){document.getElementById("clock").textContent=new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true});}

// Preload: fetch today's schedule to show cards immediately
// === PHASE 1: Instant display from manifest ===
function showManifest(){
  if(!CFG.manifest||!CFG.manifest.length) return;
  for(const m of CFG.manifest){
    const di=resolveDir(m.route,m.mode,m.headsign);
    const k=m.route+"|"+m.mode+"|"+di;
    if(!routeCache[k]) routeCache[k]={...m,etas:[],missedCycles:0};
  }
  const sorted=Object.values(routeCache).sort(prioritySort);
  cache.length=0;cache.push(...sorted);
  const el=document.getElementById("results");
  el.innerHTML=cache.map(renderCard).join("");
  attachLongPress();
  document.getElementById("updated").textContent="Loading schedules...";
}

// === PHASE 2: Schedule-based ETAs ===
async function loadScheduleETAs(){
  var gen=_locationGeneration;
  const now=Date.now();
  // Try cache first
  const cached=loadScheduleCache(currentStation);
  if(cached&&cached.length){
    applyScheduleData(cached,now);
    document.getElementById("updated").textContent="Schedule loaded (cached) — fetching live data...";
    // Refresh cache in background if older than 1 hour
    const raw=localStorage.getItem('nextup_schedule_cache');
    if(raw){try{const all=JSON.parse(raw);const entry=all[currentStation];if(entry&&now-entry.timestamp>3600000){fetchAndCacheSchedule(now,gen);}}catch(e){}}
    return;
  }
  await fetchAndCacheSchedule(now,gen);
}

async function fetchAndCacheSchedule(now,gen){
  const allStopIds=getAllStopIds();
  const allItems=[];
  const results=await Promise.allSettled(allStopIds.map(async (id, idx)=>{
    await new Promise(r=>setTimeout(r, idx * 1000)); // stagger to avoid rate limiting
    const r=await fetch(`${getOBA()}/schedule-for-stop/${id}.json?key=${getKEY()}`);
    if(!r.ok)return[];
    const j=await r.json();
    const refs={};for(const rt of j.data.references.routes||[])refs[rt.id]=rt;
    const items=[];
    for(const sr of j.data.entry.stopRouteSchedules||[]){
      const rt=refs[sr.routeId]||{};
      const cls=classify(rt.type,rt.agencyId,rt.shortName||"");
      for(const dir of sr.stopRouteDirectionSchedules||[]){
        const allTimes=(dir.scheduleStopTimes||[]).map(t=>t.arrivalTime||t.departureTime).filter(Boolean);
        if(!allTimes.length)continue;
        const route=parseRoute(rt.shortName||"?",rt.type,rt.agencyId);
        const headsign=dir.tripHeadsign||rt.longName||"";
        const di=resolveDir(route,cls.mode,headsign);
        items.push({
          route:route,
          headsign:headsign,
          dirIndex:di,
          color:rt.color?`#${rt.color}`:"#666",
          textColor:rt.textColor?`#${rt.textColor}`:"#fff",
          ...cls,
          scheduleTimes:allTimes,
        });
      }
    }
    return items;
  }));
  if(gen!==_locationGeneration) return; // location changed — discard
  for(const r of results){
    if(r.status!=="fulfilled")continue;
    allItems.push(...r.value);
  }
  // Save full schedule to cache (with all times, not just upcoming)
  saveScheduleCache(currentStation,allItems);
  applyScheduleData(allItems,now);
  document.getElementById("updated").textContent="Schedule loaded — fetching live data...";
}

/**
 * Populate TransitStore for all routes served by the current location.
 * Fetches shape + schedule for each route and saves to TransitStore.
 * Runs in background after boot — does not block the UI.
 * Skips routes already in the store with fresh schedule data.
 */
async function populateRouteStore(gen) {
  if (typeof TransitStore === 'undefined' || typeof TransitAPI === 'undefined') return;
  const dayType = typeof getDayType === 'function' ? getDayType() : 'weekday';

  // Collect all unique routeIds from the current routeCache
  const routeIds = new Set();
  for (const k in routeCache) {
    const entry = routeCache[k];
    if (entry.routeId) routeIds.add(entry.routeId);
  }

  for (const routeId of routeIds) {
    if (gen !== _locationGeneration) return; // location changed — abort

    // Step 1: Fetch and save shape if not in store
    if (!TransitStore.hasRoute(routeId)) {
      try {
        const [stopsJson, shapeJson] = await Promise.allSettled([
          TransitAPI.fetchStopsForRoute(routeId),
          TransitAPI.fetchShapeForRoute(routeId),
        ]);
        if (stopsJson.status === 'fulfilled') {
          const shapePoints = shapeJson.status === 'fulfilled'
            ? (shapeJson.value.data?.entry?.points || null) : null;
          const directions = parseRouteDirections(stopsJson.value, shapePoints);
          TransitStore.saveRoute(routeId, { directions });
        }
      } catch (e) {
        continue; // skip this route on error
      }
    }

    if (gen !== _locationGeneration) return;

    // Step 1b: Check if stored polylines are good — if bad, fetch from OSRM
    const routeEntry = TransitStore.getRoute(routeId);
    if (routeEntry && routeEntry.directions) {
      let polylineUpdated = false;
      for (const dir of routeEntry.directions) {
        // Check if polyline is bad (too short for the number of stops)
        const decoded = dir.polyline ? decodePolyline(dir.polyline) : [];
        const minPoints = Math.max(10, (dir.stopIds || []).length * 2);
        if (decoded.length < minPoints && (dir.stopIds || []).length >= 3) {
          // Polyline is bad — fetch from OSRM
          const stops = (dir.stopIds || []).map(id => dir.stops[id]).filter(s => s && s.lat && s.lon);
          if (stops.length >= 2) {
            try {
              const osrmPolyline = await TransitAPI.fetchOSRMShape(stops);
              if (osrmPolyline) {
                dir.polyline = osrmPolyline;
                polylineUpdated = true;
              }
            } catch (e) {}
          }
        }
      }
      // Save updated polylines back to store
      if (polylineUpdated) {
        TransitStore.saveRoute(routeId, { directions: routeEntry.directions });
      }
    }

    if (gen !== _locationGeneration) return;

    // Step 2: Fetch and save schedule if not in store or stale
    if (!TransitStore.hasSchedule(routeId, dayType)) {
      try {
        const entry = TransitStore.getRoute(routeId);
        if (entry && entry.directions) {
          const scheduleByDir = await TransitAPI.fetchRouteSchedule(entry.directions, 600);
          TransitStore.saveSchedule(routeId, dayType, scheduleByDir);
        }
      } catch (e) {
        // Skip schedule on error — shape data is still useful
      }
    }
  }
}

function applyScheduleData(items,now){
  for(const item of items){
    const upcomingTimes=(item.scheduleTimes||[]).filter(t=>t>now);
    // Resolve direction index (handles both cached items with dirKey and new items with dirIndex)
    const di=(item.dirIndex!==undefined)?item.dirIndex:resolveDir(item.route,item.mode,item.headsign);
    const k=item.route+"|"+item.mode+"|"+di;
    if(routeCache[k]){
      // Always store ALL scheduleTimes (including past) so we know the route exists
      routeCache[k].allScheduleTimes=item.scheduleTimes||[];
      if(upcomingTimes.length){
        // Store upcoming as persistent fallback layer
        routeCache[k].scheduleTimes=upcomingTimes;
        if(!routeCache[k].etas.length){
          const etas=upcomingTimes.slice(0,3).map(t=>({ms:t,live:false}));
          routeCache[k].etas=etas;
        }
      }
      if(item.headsign.length>(routeCache[k].headsign||"").length){
        routeCache[k].headsign=item.headsign;
      }
    } else {
      if(upcomingTimes.length){
        const etas=upcomingTimes.slice(0,3).map(t=>({ms:t,live:false}));
        routeCache[k]={...item,etas:etas,scheduleTimes:upcomingTimes,allScheduleTimes:item.scheduleTimes||[],missedCycles:0};
      } else {
        // Service ended — create entry with empty ETAs but mark it so next-day fetch can find it
        routeCache[k]={...item,etas:[],scheduleTimes:[],allScheduleTimes:item.scheduleTimes||[],missedCycles:0};
      }
    }
  }
  const sorted=Object.values(routeCache).sort(prioritySort);
  cache.length=0;cache.push(...sorted);
  const el=document.getElementById("results");
  el.innerHTML=cache.map(renderCard).join("");
  attachLongPress();
}

tick();setInterval(tick,1000);
// Boot: Phase 1 → Phase 2 → Phase 3 (update)
let refreshInterval;
(async function boot(){
  // Load pre-built route data (shapes, stops, directions) into TransitStore
  // This makes all route shapes available instantly — no runtime API calls needed
  try {
    const r = await fetch('routes-data.json');
    if (r.ok) {
      const data = await r.json();
      if (data.routes && typeof TransitStore !== 'undefined') {
        for (const [routeId, route] of Object.entries(data.routes)) {
          if (!TransitStore.hasRoute(routeId) && route.directions) {
            TransitStore.saveRoute(routeId, { directions: route.directions });
          }
        }
        console.log(`[boot] Loaded ${data.routeCount} routes from routes-data.json`);
      }
    }
  } catch (e) {
    console.warn('[boot] Could not load routes-data.json:', e.message);
  }

  // Load city config first — populates STATIONS before anything else runs
  await loadCityConfig('seattle');

  // Now resolve location (STATIONS is populated)
  urlParams = new URLSearchParams(window.location.search);
  const customLocations = loadCustomLocations();
  const defaultStation = (_cityConfig && _cityConfig.defaultStation) || 'caphill';
  const resolved = resolveLocation(urlParams.get("station"), Object.keys(STATIONS), customLocations, genericClassify);
  currentStation = resolved.id;
  currentType = resolved.type;
  if (resolved.type === 'custom') {
    const cl = customLocations.find(l => l.id === resolved.id);
    CFG = cl ? buildCustomConfig(cl, genericClassify) : STATIONS[defaultStation];
  } else {
    CFG = STATIONS[resolved.id] || STATIONS[defaultStation];
  }
  saveActiveLocation(resolved.type, resolved.id);

  // Update header now that CFG is ready
  document.getElementById("stationName").textContent = CFG.name;
  updateHeaderStar();

  // Start app-level location watch immediately — single watcher for the whole session
  if (typeof AppState !== 'undefined') AppState.startLocationWatch();
  showManifest();
  await loadScheduleETAs();
  await update();
  applyNextDayFromSchedule();
  if(refreshInterval) clearInterval(refreshInterval);
  refreshInterval=setInterval(animatedUpdate,15000);

  // Populate TransitStore in background after live data is loaded
  // (routeCache now has routeIds from the live feed)
  const _bootGen = _locationGeneration;
  setTimeout(() => populateRouteStore(_bootGen), 2000);

  // These need CFG/STATIONS to be ready — call after boot resolves
  renderLocationMenu();
})();
let rt;window.addEventListener("resize",()=>{clearTimeout(rt);rt=setTimeout(update,200);});
document.addEventListener("click",e=>{if(!e.target.closest(".station"))document.getElementById("locMenu").classList.remove("open");});
document.getElementById("creationModal").addEventListener("click",function(e){
  if(e.target===this) closeCreationModal();
});
// Onboarding
function dismissOnboard(){
  document.getElementById("onboardModal").style.display="none";
  localStorage.setItem("nextup_onboarded","1");
}
if(!localStorage.getItem("nextup_onboarded")){
  document.getElementById("onboardModal").style.display="flex";
}
function toggleTheme(){
  // Cycle: Auto → Light → Dark → Auto
  var saved=localStorage.getItem("nextup_theme");
  var next;
  if(!saved) next="light";        // Auto → Light
  else if(saved==="light") next="dark";  // Light → Dark
  else next=null;                 // Dark → Auto

  if(next){
    localStorage.setItem("nextup_theme",next);
    var isLight=next==="light";
    if(isLight) document.body.classList.add("light");
    else document.body.classList.remove("light");
  } else {
    localStorage.removeItem("nextup_theme");
    // Follow system
    var sysLight=window.matchMedia&&window.matchMedia("(prefers-color-scheme:light)").matches;
    if(sysLight) document.body.classList.add("light");
    else document.body.classList.remove("light");
  }
  updateThemeButton();
  // Notify AppState so all modules can react to theme change
  if (typeof AppState !== 'undefined') AppState.notifyThemeChange();
  var el=document.getElementById("results");
  if(cache.length) el.innerHTML=cache.map(renderCard).join("");
  attachLongPress();
}
function updateThemeButton(){
  var saved=localStorage.getItem("nextup_theme");
  var icon,label;
  if(!saved){icon="brightness_auto";label="Auto";}
  else if(saved==="light"){icon="light_mode";label="Light";}
  else{icon="dark_mode";label="Dark";}
  document.getElementById("themeIcon").textContent=icon;
  document.getElementById("themeLabel").textContent=label;
}
// Auto-detect system theme on load
(function(){
  var saved=localStorage.getItem("nextup_theme");
  var isLight;
  if(saved){isLight=saved==="light";}
  else{isLight=window.matchMedia&&window.matchMedia("(prefers-color-scheme:light)").matches;}
  if(isLight) document.body.classList.add("light");
  updateThemeButton();
  // Listen for system theme changes
  if(window.matchMedia){
    window.matchMedia("(prefers-color-scheme:light)").addEventListener("change",function(e){
      if(localStorage.getItem("nextup_theme")) return; // user override, don't auto-switch
      if(e.matches) document.body.classList.add("light");
      else document.body.classList.remove("light");
      updateThemeButton();
      var el=document.getElementById("results");
      if(cache.length) el.innerHTML=cache.map(renderCard).join("");
      attachLongPress();
    });
  }
})();
