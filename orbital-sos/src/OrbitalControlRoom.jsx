import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Radio, MapPin, ShieldCheck, AlertTriangle,
  X, Check, Clock, Globe2, Lock, User, Signal, ChevronRight,
  RadioTower, Eye, Users, Loader2, Map as MapIcon, List, ArrowLeft,
  WifiOff, BatteryMedium, Navigation, TrendingUp
} from "lucide-react";
import { MapContainer, TileLayer, Marker, Tooltip, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";


// Reference point for the map's default overview center (your ground console location)
const GROUND_STATION = { lat: 13.0067, lon: 80.2206 };


/* ===========================================================
   ORBITAL SOS — Mission Control
   Live dashboard for the bladeRF -> GNU Radio LoRa PHY ->
   OFFGRID_SOS_RX_HARDCODED.py ground-station pipeline.
=========================================================== */


// Point this at wherever OFFGRID_SOS_RX_HARDCODED.py is running.
// The RX script serves its dashboard/API on port 8080 by default.
const API_BASE = "http://127.0.0.1:8080";
const POLL_MS = 1000;


/* ---------------- Operator credentials (hardcoded for the team, lab-grade only —
   these are NOT hashed/salted and should never be reused for anything beyond this
   console). Login ID is the codename (case-insensitive); each maps to a real name
   shown in the header once signed in. ---------------- */
const OPERATORS = {
  nova:  { codename: "NOVA",  name: "Nivedhitha",  password: "nova#2026" },
  orion: { codename: "ORION", name: "Karthick",    password: "orion#2026" },
  vega:  { codename: "VEGA",  name: "Aditya",      password: "vega#2026" },
  lyra:  { codename: "LYRA",  name: "Karnika",     password: "lyra#2026" },
  comet: { codename: "COMET", name: "Madhumita",   password: "comet#2026" },
  atlas: { codename: "ATLAS", name: "Rohith Sai",  password: "atlas#2026" },
};


/* ---------------- Normalize a backend record into our card schema ---------------- */
function normalize(raw, seq) {
  if (!raw) return null;
  const isValid = raw.status === "VALID_SOS";


  return {
    id: `${raw.deviceId ?? "UNK"}-${raw.sequence ?? seq}-${raw.received_at ?? Date.now()}`,
    seq,
    status: "new", // dashboard-local workflow state: new -> acknowledged
    rxStatus: raw.status,
    valid: isValid,
    deviceId: raw.deviceId ?? "—",
    deviceName: raw.deviceName ?? "Unregistered device",
    messageId: raw.sequence ?? raw.messageId ?? "—",
    alertType: raw.alertType ?? "SOS",
    priority: raw.priority ?? "CRITICAL",
    sequenceNo: raw.sequence ?? "—",
    security: raw.security ?? (isValid ? "AES-256-GCM VERIFIED" : "UNVERIFIED"),
    authStatus: raw.authStatus ?? (isValid ? "SUCCESS" : "FAILED"),
    decryptStatus: raw.decryptStatus ?? (isValid ? "SUCCESS" : "FAILED"),
    gpsValid: !!raw.gpsValid,
    lat: raw.latitude,
    lon: raw.longitude,
    altitude: raw.altitude_m,
    hdop: raw.hdop,
    battery: raw.battery_pct,
    rssi: raw.rssi_dbm,
    snr: raw.snr_db,
    reason: raw.reason,
    receivedAt: raw.received_at ? raw.received_at * 1000 : Date.now(),
    ackAt: null,
  };
}


/* ---------------- Fallback data generator (used only while the real
   ground station is unreachable, so the UI is never a blank page) ---------------- */
const FALLBACK_LOCATIONS = [
  { name: "Nilgiri Ridge, Sector 7", lat: 11.4102, lon: 76.6950 },
  { name: "Coldwater Ravine", lat: 12.9165, lon: 77.5870 },
  { name: "Basin Trailhead", lat: 10.7867, lon: 78.7047 },
  { name: "Northface Camp", lat: 13.0827, lon: 80.2707 },
];
let fallbackSeq = 0;
let fallbackWalk = { lat: FALLBACK_LOCATIONS[0].lat, lon: FALLBACK_LOCATIONS[0].lon, deviceId: 1001 };
function makeFallbackAlert() {
  fallbackSeq += 1;
  // Slowly drift the fallback device so speed/direction/distance have something real to show.
  fallbackWalk = {
    ...fallbackWalk,
    lat: +(fallbackWalk.lat + (Math.random() - 0.45) * 0.006).toFixed(6),
    lon: +(fallbackWalk.lon + (Math.random() - 0.45) * 0.006).toFixed(6),
  };
  return {
    id: `LOCAL-${fallbackSeq}`,
    seq: fallbackSeq,
    status: "new",
    rxStatus: "VALID_SOS",
    valid: true,
    deviceId: 1001,
    deviceName: "Off-Grid Rescue Beacon #1",
    messageId: fallbackSeq,
    alertType: "SOS",
    priority: "CRITICAL",
    sequenceNo: fallbackSeq,
    security: "AES-256-GCM VERIFIED",
    authStatus: "SUCCESS",
    decryptStatus: "SUCCESS",
    gpsValid: true,
    lat: fallbackWalk.lat,
    lon: fallbackWalk.lon,
    altitude: 900 + Math.floor(Math.random() * 400),
    hdop: (0.8 + Math.random() * 1.5).toFixed(2),
    battery: Math.max(5, 98 - Math.floor(fallbackSeq * 1.3)),
    rssi: -(60 + Math.floor(Math.random() * 55)),
    snr: (Math.random() * 12 - 4).toFixed(1),
    receivedAt: Date.now(),
    ackAt: null,
  };
}


function useFallbackAlerts(active) {
  const [fallbackAlerts, setFallbackAlerts] = useState(() => [makeFallbackAlert()]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setFallbackAlerts((prev) => [makeFallbackAlert(), ...prev].slice(0, 20));
    }, 7000);
    return () => clearInterval(t);
  }, [active]);
  return fallbackAlerts;
}


/* ---------------- Live backend polling hook ---------------- */
function useGroundStation() {
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);
  const seqRef = useRef(0);
  const seenRef = useRef(new Set());


  useEffect(() => {
    let cancelled = false;


    async function poll() {
      try {
        const [lRes, hRes] = await Promise.all([
          fetch(`${API_BASE}/api/latest`, { cache: "no-store" }),
          fetch(`${API_BASE}/api/alerts`, { cache: "no-store" }),
        ]);
        const lJson = await lRes.json();
        const hJson = await hRes.json();
        if (cancelled) return;


        setConnected(true);


        const key = `${lJson.deviceId}-${lJson.sequence}-${lJson.received_at}`;
        if (lJson.received_at && !seenRef.current.has(key)) {
          seenRef.current.add(key);
          seqRef.current += 1;
          setLatest(normalize(lJson, seqRef.current));
        }


        setHistory(hJson.map((h, i) => normalize(h, hJson.length - i)).filter(Boolean));
      } catch {
        if (!cancelled) setConnected(false);
      }
    }


    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);


  return { connected, latest, history };
}


/* ---------------- Geo helpers (speed / direction / distance) ---------------- */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}


function compassLabel(deg) {
  const dirs = ["North ↑", "North-East ↗", "East →", "South-East ↘", "South ↓", "South-West ↙", "West ←", "North-West ↖"];
  return dirs[Math.round(deg / 45) % 8];
}


/* Build a chronological GPS track per device out of every packet seen so far */
function useDeviceTracks(alerts) {
  return useMemo(() => {
    const byDevice = {};
    [...alerts]
      .filter((a) => a.lat != null && a.lon != null)
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .forEach((a) => {
        if (!byDevice[a.deviceId]) byDevice[a.deviceId] = [];
        const track = byDevice[a.deviceId];
        const prev = track[track.length - 1];
        if (!prev || prev.receivedAt !== a.receivedAt) track.push(a);
      });
    return byDevice;
  }, [alerts]);
}


function computeDeviceMetrics(track) {
  if (!track || track.length === 0) return null;
  const last = track[track.length - 1];
  let totalDistanceKm = 0;
  for (let i = 1; i < track.length; i++) {
    totalDistanceKm += haversineKm(track[i - 1].lat, track[i - 1].lon, track[i].lat, track[i].lon);
  }
  let speedKmh = 0;
  let direction = null;
  if (track.length > 1) {
    const prev = track[track.length - 2];
    const legKm = haversineKm(prev.lat, prev.lon, last.lat, last.lon);
    const hours = Math.max((last.receivedAt - prev.receivedAt) / 3600000, 1 / 3600);
    speedKmh = legKm / hours;
    direction = bearingDeg(prev.lat, prev.lon, last.lat, last.lon);
  }
  return {
    last,
    speedKmh,
    direction,
    totalDistanceKm,
    secondsSinceUpdate: Math.max(0, Math.floor((Date.now() - last.receivedAt) / 1000)),
  };
}


/* ---------------- Smart automatic alert detection ---------------- */
function useSmartAlerts(alerts) {
  const [systemAlerts, setSystemAlerts] = useState([]);
  const prevRef = useRef({});
  const idCounter = useRef(0);


  const push = (type, deviceId, message) => {
    idCounter.current += 1;
    setSystemAlerts((prev) => [
      { id: `sa-${idCounter.current}`, type, deviceId, message, at: Date.now() },
      ...prev,
    ].slice(0, 30));
  };


  useEffect(() => {
    if (!alerts.length) return;
    const latestByDevice = {};
    alerts.forEach((a) => {
      const cur = latestByDevice[a.deviceId];
      if (!cur || a.receivedAt > cur.receivedAt) latestByDevice[a.deviceId] = a;
    });


    Object.values(latestByDevice).forEach((a) => {
      const prev = prevRef.current[a.deviceId];


      if (!prev) {
        prevRef.current[a.deviceId] = {
          rssi: a.rssi, lat: a.lat, lon: a.lon, receivedAt: a.receivedAt,
          firstStillAt: a.receivedAt, stillFired: false, offlineFired: false,
        };
        return;
      }


      const isNewPacket = a.receivedAt !== prev.receivedAt;


      if (prev.offlineFired && isNewPacket) {
        push("signal-restored", a.deviceId, `Device is back online`);
      }


      if (isNewPacket && prev.rssi != null && a.rssi != null) {
        if (prev.rssi - a.rssi >= 20) {
          push("signal-drop", a.deviceId, `Signal dropped from ${prev.rssi} dBm to ${a.rssi} dBm`);
        } else if (a.rssi - prev.rssi >= 20) {
          push("signal-restored", a.deviceId, `Signal recovered to ${a.rssi} dBm`);
        }
      }


      const samePos = prev.lat != null && a.lat != null &&
        Math.abs(prev.lat - a.lat) < 0.0003 && Math.abs(prev.lon - a.lon) < 0.0003;
      const firstStillAt = samePos ? prev.firstStillAt : a.receivedAt;
      const stillDuration = a.receivedAt - firstStillAt;
      const stillFired = samePos ? prev.stillFired : false;


      if (samePos && !stillFired && stillDuration > 5 * 60 * 1000) {
        push("not-moving", a.deviceId, `Device has not moved for over 5 minutes`);
      }


      prevRef.current[a.deviceId] = {
        rssi: a.rssi,
        lat: a.lat,
        lon: a.lon,
        receivedAt: a.receivedAt,
        firstStillAt,
        stillFired: samePos ? (stillFired || stillDuration > 5 * 60 * 1000) : false,
        offlineFired: false,
      };
    });
  }, [alerts]);


  // Ticks independently of new packets so "device offline" can fire even when nothing arrives.
  useEffect(() => {
    const t = setInterval(() => {
      Object.entries(prevRef.current).forEach(([deviceId, info]) => {
        if (!info.offlineFired && Date.now() - info.receivedAt > 2 * 60 * 1000) {
          push("offline", deviceId, `No data received for over 2 minutes`);
          info.offlineFired = true;
        }
      });
    }, 10000);
    return () => clearInterval(t);
  }, []);


  return systemAlerts;
}


/* ---------------- Small distant planet (Mars/Saturn-style), used as background dressing ---------------- */
function DistantPlanet({ size = 60, top, left, hue = "#c96b4a", ringed = false, opacity = 0.85 }) {
  return (
    <div className="absolute pointer-events-none" style={{ top, left, width: size, height: size, opacity }}>
      {ringed && (
        <div className="absolute rounded-full border border-cyan-100/25"
          style={{ width: size * 1.9, height: size * 0.55, top: size * 0.22, left: -size * 0.45, transform: "rotate(-18deg)", boxShadow: "0 0 8px rgba(226,232,240,0.15)" }} />
      )}
      <div className="absolute inset-0 rounded-full" style={{
        background: `radial-gradient(circle at 32% 28%, ${hue}dd 0%, ${hue}99 35%, #1c0f0a 78%)`,
        boxShadow: `0 0 ${size * 0.5}px ${hue}33`,
      }} />
      <div className="absolute inset-0 rounded-full" style={{ background: "linear-gradient(120deg, transparent 40%, rgba(0,0,0,0.55) 90%)" }} />
    </div>
  );
}


/* ---------------- Shooting stars: fast diagonal streaks that fire occasionally ---------------- */
function ShootingStars() {
  const streaks = useMemo(
    () => Array.from({ length: 5 }, (_, i) => ({
      top: 5 + Math.random() * 55,
      left: 10 + Math.random() * 70,
      delay: i * 3.4 + Math.random() * 3,
      duration: 1.6 + Math.random() * 1.2,
      cycle: 9 + Math.random() * 6,
      len: 90 + Math.random() * 70,
    })),
    []
  );
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {streaks.map((s, i) => (
        <div key={i} className="absolute rounded-full"
          style={{
            top: `${s.top}%`, left: `${s.left}%`, width: s.len, height: 1.6,
            background: "linear-gradient(90deg, rgba(255,255,255,0.95), rgba(255,255,255,0))",
            filter: "drop-shadow(0 0 4px rgba(255,255,255,0.9))",
            transformOrigin: "left center",
            animation: `shoot ${s.duration}s ease-in ${s.cycle}s infinite`,
            animationDelay: `${s.delay}s`,
            opacity: 0,
          }} />
      ))}
      <style>{`
        @keyframes shoot {
          0% { transform: rotate(215deg) translateX(0); opacity: 0; }
          4% { opacity: 1; }
          22% { transform: rotate(215deg) translateX(-260px); opacity: 0; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}


/* ---------------- Starfield background ---------------- */
function Starfield({ extras = false }) {
  const stars = useMemo(
    () => Array.from({ length: 110 }, () => ({
      top: Math.random() * 100, left: Math.random() * 100,
      size: Math.random() < 0.8 ? 1 : 2, delay: Math.random() * 4,
    })),
    []
  );
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {stars.map((s, i) => (
        <div key={i} className="absolute rounded-full bg-white animate-pulse"
          style={{ top: `${s.top}%`, left: `${s.left}%`, width: s.size, height: s.size, opacity: 0.55, animationDelay: `${s.delay}s`, animationDuration: "3.5s" }} />
      ))}
      {extras && (
        <>
          {/* Nearby planets, glimpsed at the edges of frame like the reference shots — login screen only */}
          <DistantPlanet size={70} top="8%" left="86%" hue="#c96b4a" opacity={0.55} />
          <DistantPlanet size={130} top="68%" left="-6%" hue="#d7b98a" ringed opacity={0.4} />
          <ShootingStars />
        </>
      )}
      <div className="absolute -top-32 -right-32 w-[520px] h-[520px] rounded-full bg-cyan-500/10 blur-[110px]" />
      <div className="absolute -bottom-32 -left-32 w-[420px] h-[420px] rounded-full bg-blue-600/10 blur-[110px]" />
      <div className="absolute top-1/3 left-1/2 w-[300px] h-[300px] rounded-full bg-indigo-500/5 blur-[90px]" />
    </div>
  );
}


/* ---------------- Realistic spinning Earth (dynamic layered CSS sphere) ---------------- */
function Earth({ size = 180, spin = true, breathe = true }) {
  return (
    <div className={`relative rounded-full ${breathe ? "animate-[breathe_6s_ease-in-out_infinite]" : ""}`}
      style={{ width: size, height: size, filter: "drop-shadow(0 0 45px rgba(34,211,238,0.4))" }}>
      <div className="absolute inset-0 rounded-full overflow-hidden">
        <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 32% 28%, #2c7fc9 0%, #1c5f9e 25%, #0d3a68 55%, #051b34 100%)" }} />
        <div className={`absolute inset-0 ${spin ? "animate-[spin_28s_linear_infinite]" : ""}`}
          style={{
            backgroundImage: `
              radial-gradient(circle at 18% 32%, rgba(45,155,90,0.6) 0 10%, transparent 11%),
              radial-gradient(circle at 52% 18%, rgba(45,155,90,0.55) 0 7%, transparent 8%),
              radial-gradient(circle at 68% 55%, rgba(45,155,90,0.6) 0 12%, transparent 13%),
              radial-gradient(circle at 28% 68%, rgba(45,155,90,0.5) 0 8%, transparent 9%),
              radial-gradient(circle at 85% 22%, rgba(45,155,90,0.45) 0 5%, transparent 6%),
              radial-gradient(circle at 40% 85%, rgba(45,155,90,0.4) 0 6%, transparent 7%)
            `,
          }} />
        <div className="absolute inset-0 opacity-45 animate-[spin_46s_linear_infinite_reverse]"
          style={{ backgroundImage: "radial-gradient(circle at 40% 60%, rgba(255,255,255,0.55) 0 4%, transparent 5%), radial-gradient(circle at 65% 30%, rgba(255,255,255,0.45) 0 6%, transparent 7%), radial-gradient(circle at 20% 20%, rgba(255,255,255,0.35) 0 3%, transparent 4%)" }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(115deg, transparent 38%, rgba(0,0,0,0.6) 88%)" }} />
      </div>
      <div className="absolute -inset-1 rounded-full ring-2 ring-cyan-300/25 animate-[pulse_4s_ease-in-out_infinite]" />
      <style>{`@keyframes breathe { 0%,100% { transform: scale(1);} 50% { transform: scale(1.015);} }`}</style>
    </div>
  );
}


/* ---------------- Realistic satellite (custom SVG with glinting panels + blinking nav light) ---------------- */
function SatelliteGlyph({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="drop-shadow-[0_0_10px_rgba(103,232,249,0.85)]">
      <defs>
        <linearGradient id="panelGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#0a2540" />
        </linearGradient>
      </defs>
      <rect x="7" y="24" width="16" height="6" rx="1" fill="url(#panelGrad)" stroke="#67e8f9" strokeWidth="1.2" />
      <rect x="41" y="24" width="16" height="6" rx="1" fill="url(#panelGrad)" stroke="#67e8f9" strokeWidth="1.2" />
      {[9, 12, 15, 18].map((x) => <line key={"l" + x} x1={x} y1="24.5" x2={x} y2="29.5" stroke="#0a2540" strokeWidth="0.5" opacity="0.7" />)}
      {[43, 46, 49, 52, 55].map((x) => <line key={"r" + x} x1={x} y1="24.5" x2={x} y2="29.5" stroke="#0a2540" strokeWidth="0.5" opacity="0.7" />)}
      <rect x="23" y="21" width="18" height="12" rx="2" fill="#e2e8f0" stroke="#67e8f9" strokeWidth="1.2" />
      <circle cx="32" cy="27" r="2.2" fill="#38bdf8">
        <animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite" />
      </circle>
      <path d="M28 33 L26 40" stroke="#94a3b8" strokeWidth="1.2" />
      <circle cx="25" cy="42" r="4.5" fill="#cbd5e1" stroke="#67e8f9" strokeWidth="1" />
      <path d="M24 21 L24 17" stroke="#94a3b8" strokeWidth="1" />
      <circle cx="24" cy="16" r="1.4" fill="#f87171">
        <animate attributeName="opacity" values="1;0.15;1" dur="1.1s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}


/* ---------------- Orbit scene: Earth + orbiting satellite + dotted signal.
   True front/back geometry, like looking at a tilted ring side-on: the
   BOTTOM arc of the ellipse is the near side (in front of the planet, fully
   visible, larger as it swings closer to the viewer) and the TOP arc is the
   far side (behind the planet, completely hidden — not just faded). This is
   read directly off the satellite's position each frame, not inferred from
   its direction of travel, so front/back is always geometrically correct.
   Press-and-hold the satellite to pause it in place; release to resume. ---------------- */
function OrbitScene({ size = 340, extras = false }) {
  const [angle, setAngle] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setAngle((a) => (a - 1.2 + 360) % 360), 40);
    return () => clearInterval(t);
  }, [paused]);

  const cx = size / 2, cy = size / 2, rx = size * 0.42, ry = size * 0.16;
  const rad = (angle * Math.PI) / 180;
  const satX = cx + rx * Math.cos(rad);
  const satY = cy + ry * Math.sin(rad);
  const earthSize = size * 0.42;

  // depth: -1 at the far top (directly behind the planet) .. +1 at the near
  // bottom (directly in front, closest to the viewer).
  // >>> If the front/back side ever looks backwards, swap this one line: <<<
  const depth = Math.sin(rad);
  const scale = 0.78 + 0.34 * ((depth + 1) / 2); // smoothly bigger as it comes toward the front
  // Fades out over the last ~10% of the depth range as it crosses the horizon,
  // instead of vanishing/appearing instantly — that abrupt cut was the "flip".
  const visibility = Math.max(0, Math.min(1, depth * 10));
  const behind = visibility <= 0;

  const stop = () => setPaused(true);
  const go = () => setPaused(false);

  return (
    <div className="relative mx-auto overflow-visible" style={{ width: size, height: size }}>
      {extras && <DistantPlanet size={size * 0.16} top={-size * 0.03} left={size * 0.86} hue="#c96b4a" opacity={0.6} />}
      <svg className="absolute inset-0" width={size} height={size}>
        {/* Far (back) half of the ring — dim, since the planet occludes it */}
        <path d={`M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`} fill="none" stroke="rgba(56,189,248,0.10)" strokeWidth="1" />
        {/* Near (front) half of the ring — brighter, unoccluded */}
        <path d={`M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 0 ${cx + rx} ${cy}`} fill="none" stroke="rgba(56,189,248,0.3)" strokeWidth="1.2" />
        <line x1={satX} y1={satY} x2={cx} y2={cy} stroke="#38d7ff" strokeWidth="1.4" strokeDasharray="3 6" opacity={0.85 * visibility}>
          <animate attributeName="stroke-dashoffset" from="0" to="-18" dur="0.8s" repeatCount="indefinite" />
        </line>
      </svg>
      <div className="absolute" style={{ top: cy - earthSize / 2, left: cx - earthSize / 2, zIndex: 5 }}>
        <Earth size={earthSize} />
      </div>
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer select-none"
        style={{
          top: satY, left: satX, zIndex: 6, opacity: visibility,
          pointerEvents: behind ? "none" : "auto",
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
        onMouseDown={stop}
        onMouseUp={go}
        onMouseLeave={go}
        onTouchStart={stop}
        onTouchEnd={go}
        title={paused ? "Release to resume orbit" : "Hold to pause"}
      >
        <SatelliteGlyph size={size <= 220 ? 26 : Math.round(size * 0.09)} />
      </div>
    </div>
  );
}


/* ---------------- Connection badge ---------------- */
function LinkBadge({ connected }) {
  return connected ? (
    <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
      </span>
      Ground station linked
    </div>
  ) : (
    <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
      <WifiOff size={12} /> Ground station offline — showing local feed
    </div>
  );
}


/* ---------------- Login Screen ---------------- */
function LoginScreen({ onSubmit, connected }) {
  const [loginId, setLoginId] = useState("");
  const [pwd, setPwd] = useState("");
  const [error, setError] = useState("");


  const handle = (e) => {
    e.preventDefault();
    if (!loginId.trim() || !pwd.trim()) { setError("Enter both a login ID and password."); return; }
    const operator = OPERATORS[loginId.trim().toLowerCase()];
    if (!operator || operator.password !== pwd) {
      setError("Invalid codename or password.");
      return;
    }
    setError("");
    onSubmit(operator);
  };


  return (
    <div className="min-h-screen w-full bg-[#020814] relative flex items-center justify-center overflow-hidden font-[Inter,sans-serif] px-6">
      <Starfield extras />
      <div className="relative z-10 w-full max-w-7xl grid grid-cols-1 lg:grid-cols-[1.3fr_380px] gap-10 items-center">
        <div className="flex flex-col items-center">
          {/* Enlarged orbit scene — occupies roughly half the left side of the screen */}
          <div className="w-full flex justify-center">
            <OrbitScene size={520} extras />
          </div>
          <h1 className="mt-2 text-2xl tracking-[0.2em] text-white font-semibold">ORBITAL SOS</h1>
          <p className="text-xs tracking-[0.35em] text-cyan-400/80 uppercase mb-2">Mission Control</p>
          <LinkBadge connected={connected} />
        </div>


        <form onSubmit={handle} className="bg-white/[0.03] backdrop-blur-xl border border-cyan-400/20 rounded-2xl p-7 shadow-[0_0_60px_rgba(8,145,178,0.15)]">
          <p className="text-[11px] tracking-[0.25em] text-cyan-400/80 uppercase mb-5">Admin Access</p>


          <label className="block text-[11px] tracking-[0.2em] text-slate-400 mb-2 uppercase">Login ID</label>
          <div className="relative mb-4">
            <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-cyan-500/70" />
            <input value={loginId} onChange={(e) => { setLoginId(e.target.value); setError(""); }} placeholder="operator codename"
              className="w-full bg-black/40 border border-cyan-500/20 focus:border-cyan-400/70 outline-none rounded-lg py-3 pl-10 pr-3 text-white tracking-wide placeholder:text-slate-600 transition-colors" />
          </div>


          <label className="block text-[11px] tracking-[0.2em] text-slate-400 mb-2 uppercase">Password</label>
          <div className="relative mb-1">
            <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-cyan-500/70" />
            <input type="password" value={pwd} onChange={(e) => { setPwd(e.target.value); setError(""); }} placeholder="••••••••"
              className="w-full bg-black/40 border border-cyan-500/20 focus:border-cyan-400/70 outline-none rounded-lg py-3 pl-10 pr-3 text-white tracking-widest placeholder:text-slate-600 transition-colors" />
          </div>
          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}


          <button type="submit" className="mt-6 w-full group relative overflow-hidden rounded-lg py-3 font-medium text-sm tracking-wide text-[#02121f] bg-cyan-400 hover:bg-cyan-300 transition-colors flex items-center justify-center gap-2">
            Initiate Uplink
            <ChevronRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
          </button>


          <div className="mt-5 flex items-center justify-between text-[10px] text-slate-500 tracking-wider uppercase">
            <span className="flex items-center gap-1"><Radio size={11} /> 868.10 MHz</span>
            <span className="flex items-center gap-1"><ShieldCheck size={11} /> AES-256-GCM</span>
          </div>
        </form>
      </div>
    </div>
  );
}


/* ---------------- Ground station dish with scanning sweep ---------------- */
function GroundStationGlyph({ size = 30, active = true }) {
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 64 64" className="drop-shadow-[0_0_10px_rgba(103,232,249,0.7)]">
        <path d="M32 8 A22 22 0 0 1 54 30" fill="none" stroke="#67e8f9" strokeWidth="2" opacity="0.35" />
        <ellipse cx="32" cy="30" rx="16" ry="9" fill="#0a2540" stroke="#67e8f9" strokeWidth="1.4" transform="rotate(-25 32 30)" />
        <circle cx="32" cy="30" r="2" fill="#38bdf8" />
        <line x1="32" y1="30" x2="32" y2="48" stroke="#94a3b8" strokeWidth="2" />
        <path d="M20 58 L32 48 L44 58" fill="none" stroke="#94a3b8" strokeWidth="2" />
        {active && (
          <circle cx="32" cy="30" r="3" fill="none" stroke="#38d7ff" strokeWidth="1.5">
            <animate attributeName="r" values="3;18;3" dur="2.2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.9;0;0.9" dur="2.2s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>
    </div>
  );
}


/* ---------------- Uplink Transition: a centered, HUD-style space scene —
   radar sweep + targeting brackets around the orbiting Earth/satellite,
   flanked by the device -> satellite -> ground-station relay, in a
   starfield full of surrounding planets and shooting stars — ending on a
   confirmation beat. ---------------- */
function UplinkTransition({ onComplete }) {
  const steps = [
    "Acquiring GPS fix from field device...",
    "Broadcasting LoRa packet — 868.10 MHz...",
    "Relaying via satellite uplink...",
    "Downlinking to ground station...",
    "Decrypting AES-256-GCM payload...",
    "The Rescue Team is On Board!",
  ];
  const [stepIndex, setStepIndex] = useState(0);
  const [zoom, setZoom] = useState(false);
  const done = stepIndex >= steps.length - 1;
  const TICKS = 24;


  useEffect(() => {
    if (stepIndex >= steps.length - 1) {
      const t = setTimeout(() => setZoom(true), 950);
      const t2 = setTimeout(onComplete, 1600);
      return () => { clearTimeout(t); clearTimeout(t2); };
    }
    const t = setTimeout(() => setStepIndex((i) => i + 1), 640);
    return () => clearTimeout(t);
  }, [stepIndex]);


  const progress = Math.min(100, Math.round((stepIndex / (steps.length - 1)) * 100));
  const litTicks = Math.round((progress / 100) * TICKS);


  return (
    <div className="min-h-screen w-full bg-[#020814] relative overflow-hidden flex flex-col items-center justify-center">
      <Starfield extras />

      {/* Faint targeting grid, for that HUD/mission-control feel */}
      <div className="absolute inset-0 opacity-[0.07] pointer-events-none" style={{
        backgroundImage: "linear-gradient(rgba(103,232,249,1) 1px, transparent 1px), linear-gradient(90deg, rgba(103,232,249,1) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
      }} />

      <div className={`relative z-10 flex flex-col items-center transition-all duration-700 ${zoom ? "scale-125 opacity-0" : "scale-100 opacity-100"}`}>
        {/* Relay row: field device -- (signal) -- hero orbit -- (signal) -- ground station */}
        <div className="flex items-center justify-center gap-3 sm:gap-6">
          <div className="flex flex-col items-center gap-2 w-16 sm:w-20 shrink-0">
            <MapPin size={22} className="text-red-400 drop-shadow-[0_0_8px_rgba(248,113,113,0.9)]" />
            <span className="text-[8px] sm:text-[9px] tracking-widest text-slate-500 uppercase text-center leading-tight">Field<br />Device</span>
          </div>

          <SignalLink active={stepIndex >= 1} />

          {/* Hero: radar sweep + targeting brackets around the orbiting Earth/satellite */}
          <div className="relative shrink-0" style={{ width: 300, height: 300 }}>
            <div className="absolute inset-0 rounded-full animate-spin" style={{
              animationDuration: "3.2s",
              background: "conic-gradient(from 0deg, transparent 0deg, rgba(56,215,255,0.28) 18deg, transparent 46deg)",
            }} />
            <div className="absolute inset-6 rounded-full border border-cyan-400/15" />
            <div className="absolute inset-[38px] rounded-full border border-cyan-400/10" />
            {/* Targeting-reticle corner brackets */}
            {[
              "top-0 left-0 border-t-2 border-l-2",
              "top-0 right-0 border-t-2 border-r-2",
              "bottom-0 left-0 border-b-2 border-l-2",
              "bottom-0 right-0 border-b-2 border-r-2",
            ].map((pos, i) => (
              <div key={i} className={`absolute ${pos} w-6 h-6 border-cyan-300/50`} />
            ))}
            <div className="absolute inset-0 flex items-center justify-center">
              <OrbitScene size={230} />
            </div>
          </div>

          <SignalLink active={stepIndex >= 3} />

          <div className="flex flex-col items-center gap-2 w-16 sm:w-20 shrink-0">
            <GroundStationGlyph size={30} active={stepIndex >= 3} />
            <span className="text-[8px] sm:text-[9px] tracking-widest text-slate-500 uppercase text-center leading-tight">Ground<br />Station</span>
          </div>
        </div>

        {/* HUD status readout */}
        <div className="w-80 sm:w-96 text-center mt-8">
          <p className={`text-sm tracking-wide mb-4 h-5 font-mono transition-colors ${done ? "text-emerald-300 font-semibold tracking-[0.15em]" : "text-cyan-300"}`}>
            {done && <Check size={14} className="inline mr-1.5 -mt-0.5" />}
            {steps[stepIndex]}
          </p>
          <div className="flex gap-[3px] justify-center">
            {Array.from({ length: TICKS }).map((_, i) => (
              <div key={i} className={`h-3 w-2 rounded-[1px] transition-colors duration-300 ${i < litTicks ? (done ? "bg-emerald-400" : "bg-cyan-400") : "bg-white/10"}`}
                style={i < litTicks ? { boxShadow: `0 0 6px ${done ? "rgba(52,211,153,0.8)" : "rgba(56,215,255,0.8)"}` } : undefined} />
            ))}
          </div>
          <p className="mt-3 text-[10px] tracking-[0.3em] text-slate-500 uppercase font-mono">
            {done ? "All Systems Nominal" : `SYS// ${progress}% Synced`}
          </p>
        </div>
      </div>

      <style>{`
        @keyframes float { 0%,100% { transform: translateY(0);} 50% { transform: translateY(-6px);} }
        @keyframes signalFlow { from { background-position: 0 0; } to { background-position: 20px 0; } }
      `}</style>
    </div>
  );
}


/* Animated flowing dashed link used in the relay row (device/ground-station <-> hero) */
function SignalLink({ active }) {
  return (
    <div className="hidden sm:block h-px w-10 md:w-16 shrink-0" style={{
      backgroundImage: `repeating-linear-gradient(90deg, ${active ? "#38d7ff" : "rgba(56,215,255,0.25)"} 0 6px, transparent 6px 14px)`,
      backgroundSize: "20px 1px",
      animation: active ? "signalFlow 0.6s linear infinite" : "none",
      opacity: active ? 0.9 : 0.35,
    }} />
  );
}





/* ---------------- Packet card (matches RX backend schema + AUTHENTICATED SOS RECEIVED payload) ---------------- */
function PacketCard({ alert, onAck, onViewLocation, live = true }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      const end = alert.ackAt || Date.now();
      setElapsed(Math.max(0, Math.floor((end - alert.receivedAt) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [alert, live]);


  const fmt = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;
  const statusColors = {
    new: "text-cyan-300 border-cyan-400/40 bg-cyan-400/10",
    acknowledged: "text-white border-emerald-500 bg-emerald-500",
  };


  const decoder = [
    ["PREAMBLE", "DETECTED"],
    ["SYNC WORD", "LOCKED"],
    ["PAYLOAD (64B)", "RECOVERED"],
    ["AUTHENTICATION", alert.authStatus === "SUCCESS" ? "SUCCESS" : "FAILED"],
    ["DECRYPTION", alert.decryptStatus === "SUCCESS" ? "SUCCESS" : "FAILED"],
  ];


  return (
    <div className="bg-[#050f1f] border border-cyan-400/20 rounded-2xl overflow-hidden w-full max-w-2xl">
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 bg-white/[0.02]">
        <span className="text-cyan-300 text-xs tracking-widest font-semibold flex items-center gap-1.5">
          <AlertTriangle size={13} className="text-red-400" />
          AUTHENTICATED {alert.alertType || "SOS"} RECEIVED
        </span>
        <div className="flex items-center gap-3">
          <span className="hidden sm:flex items-center gap-1 text-[10px] text-slate-500">
            <Clock size={11} /> {alert.status === "acknowledged" ? "Response time" : "Time elapsed"}
            <span className="text-cyan-300 font-mono">{fmt(elapsed)}</span>
          </span>
          <span className={`text-[10px] px-2 py-1 rounded-full border tracking-wide uppercase ${statusColors[alert.status]}`}>
            {alert.status === "new" ? "pending" : alert.status}
          </span>
        </div>
      </div>

      {/* Identity + alert type in one wide row, mirroring the raw ground-station payload order */}
      <div className="grid grid-cols-3 gap-2 p-4 pb-2">
        {[
          ["Device ID", alert.deviceId],
          ["Message ID", alert.messageId],
          ["Alert Type", <span className="text-red-300">{alert.alertType || "SOS"}</span>],
        ].map(([label, value], i) => (
          <div key={i} className="bg-black/30 border border-white/5 rounded-lg px-3 py-2">
            <p className="text-[9px] tracking-widest text-slate-500 uppercase mb-0.5">{label}</p>
            <p className="text-sm text-white font-mono font-semibold truncate">{value}</p>
          </div>
        ))}
      </div>

      <div className="px-4 pb-2">
        <p className="text-[9px] tracking-widest text-slate-500 uppercase mb-1.5 flex items-center gap-1"><MapPin size={10} /> Location</p>
        <div className="grid grid-cols-4 gap-2">
          {[
            ["Latitude", alert.lat != null ? Number(alert.lat).toFixed(7) : "—"],
            ["Longitude", alert.lon != null ? Number(alert.lon).toFixed(7) : "—"],
            ["Altitude", alert.altitude != null ? `${alert.altitude} m` : "—"],
            ["HDOP", alert.hdop ?? "—"],
          ].map(([label, value], i) => (
            <div key={i} className="bg-black/30 border border-white/5 rounded-lg px-3 py-2">
              <p className="text-[9px] tracking-widest text-slate-500 uppercase mb-0.5">{label}</p>
              <p className="text-sm text-white font-mono truncate">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 px-4 pb-4">
        {[
          ["Battery", alert.battery != null ? `${alert.battery} %` : "unknown"],
          ["Timestamp", new Date(alert.receivedAt).toLocaleTimeString()],
          ["RSSI / SNR", `${alert.rssi ?? "—"} dBm / ${alert.snr ?? "—"} dB`],
          ["GPS", alert.gpsValid ? <span className="text-emerald-400">VALID</span> : <span className="text-amber-400">NO FIX</span>],
        ].map(([label, value], i) => (
          <div key={i} className="bg-black/30 border border-white/5 rounded-lg px-3 py-2">
            <p className="text-[9px] tracking-widest text-slate-500 uppercase mb-0.5">{label}</p>
            <p className="text-sm text-white font-mono truncate">{value}</p>
          </div>
        ))}
      </div>

      <div className="px-4 pb-4 flex items-center gap-2">
        <button disabled={alert.status !== "new"} onClick={() => onAck(alert.id)}
          className={`flex-1 flex items-center justify-center gap-1.5 text-[11px] py-2 rounded-lg border font-medium transition-colors ${alert.status !== "new" ? "border-emerald-500 text-white bg-emerald-500 cursor-default" : "border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10"}`}>
          <Check size={13} /> {alert.status === "new" ? "Acknowledge" : "Acknowledged"}
        </button>
        <button disabled={alert.lat == null || alert.lon == null} onClick={() => onViewLocation(alert)}
          className={`flex-1 flex items-center justify-center gap-1.5 text-[11px] py-2 rounded-lg border transition-colors ${alert.lat == null ? "border-white/10 text-slate-600 cursor-not-allowed" : "border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10"}`}>
          <MapPin size={13} /> {alert.lat == null ? "No GPS Fix" : "View Location"}
        </button>
      </div>

      <div className="border-t border-white/5 px-4 py-3 bg-white/[0.015]">
        <p className="text-[10px] tracking-widest text-slate-500 uppercase mb-2">06 // Packet Decoder</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
          {decoder.map(([label, state], i) => (
            <div key={i} className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">{label}</span>
              <span className={`flex items-center gap-1 ${state === "FAILED" ? "text-red-400" : "text-emerald-400"}`}>
                <Check size={11} /> {state}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


function DetailsModal({ alert, onClose, onAck, onViewLocation }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="relative">
        <button onClick={onClose} className="absolute -top-3 -right-3 z-10 bg-[#0a1626] border border-cyan-400/30 rounded-full p-1.5 text-slate-300 hover:text-white transition-colors">
          <X size={16} />
        </button>
        <PacketCard alert={alert} onAck={onAck} onViewLocation={onViewLocation} />
      </div>
    </div>
  );
}


function AckToast({ toasts }) {
  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <div key={t.key} className="w-72 bg-[#04120f] border border-emerald-400/30 rounded-xl px-4 py-3 shadow-[0_0_30px_rgba(16,185,129,0.2)] animate-[slideIn_0.3s_ease-out]">
          <div className="flex items-center gap-2 text-emerald-400 text-xs tracking-widest uppercase mb-1"><Check size={14} /> Acknowledgment Done</div>
          <p className="text-slate-300 text-xs leading-snug">Rescue team heading to <span className="text-white">Device {t.deviceId}</span></p>
        </div>
      ))}
      <style>{`@keyframes slideIn { from { opacity:0; transform: translateX(20px);} to { opacity:1; transform: translateX(0);} }`}</style>
    </div>
  );
}


/* ---------------- Waveform / RSSI panel (link-activity trace + a REAL RSSI trend) ----------------
   NOTE ON WHAT'S REAL vs STYLISED, based on what the ground-station API actually exposes
   (/api/latest, /api/alerts returning per-packet JSON with rssi_dbm/snr_db scalars — no
   raw IQ samples or FFT bins are streamed to the frontend):
     - "Link Activity" (left) has no real per-sample waveform to draw from, so it stays a
       lightweight, clearly-labelled stylised burst indicator — it only animates while a
       packet is actively being processed (`active`), it does not claim to be a captured
       signal trace, and it carries no numeric axis that could be mistaken for real values.
     - "RSSI Trend" (right) plots REAL telemetry: the actual `rssi_dbm` values reported for
       the last several decoded packets, so it moves only when genuine data arrives. A true
       spectrum/FFT view would need the RX pipeline (GNU Radio) to publish bin data over the
       API — that's a backend change, not something the frontend can fabricate honestly.
------------------------------------------------------------------------------------------- */
function Waveform({ active, history = [] }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 140);
    return () => clearInterval(t);
  }, []);

  const timePoints = useMemo(() => {
    const N = 160;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const burstOn = Math.floor(i / 22) % 2 === 0;
      const carrier = Math.sin(i * 1.35 + tick * 0.3) * Math.sin(i * 0.22 + tick * 0.05);
      const noise = (Math.random() - 0.5) * 0.15;
      const amp = active ? (burstOn ? carrier : noise * 0.4) : noise * 0.2;
      pts.push(amp);
    }
    return pts;
  }, [tick, active]);

  const w = 320, h = 44;
  const linePath = timePoints
    .map((v, i) => {
      const x = (i / (timePoints.length - 1)) * w;
      const y = h / 2 - v * (h / 2 - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Real RSSI values only (drop nulls), oldest -> newest, capped to what we were given.
  const pts = history.filter((p) => p && p.rssi != null);
  const rssiMin = pts.length ? Math.min(...pts.map((p) => p.rssi)) : -120;
  const rssiMax = pts.length ? Math.max(...pts.map((p) => p.rssi)) : -40;
  const span = Math.max(1, rssiMax - rssiMin);
  const hw = 320, hh = 44;
  const rssiPath = pts.length > 1
    ? pts
        .map((p, i) => {
          const x = (i / (pts.length - 1)) * hw;
          const t = (p.rssi - rssiMin) / span;
          const y = hh - t * (hh - 8) - 4;
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : "";

  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-[9px] tracking-widest text-slate-500 uppercase mb-1">Link Activity <span className="text-slate-600 normal-case">(indicator, not a captured trace)</span></p>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-11">
          <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="rgba(103,232,249,0.12)" strokeWidth="1" />
          <path d={linePath} fill="none" stroke="#38d7ff" strokeWidth="1.3"
            style={{ filter: "drop-shadow(0 0 4px rgba(56,215,255,0.65))" }} />
        </svg>
      </div>
      <div>
        <p className="text-[9px] tracking-widest text-slate-500 uppercase mb-1 flex items-center justify-between">
          <span>RSSI Trend · last {pts.length} pkt{pts.length === 1 ? "" : "s"} (real telemetry)</span>
          {pts.length > 0 && <span className="text-slate-600 normal-case tracking-normal font-mono">{rssiMin}…{rssiMax} dBm</span>}
        </p>
        {pts.length > 1 ? (
          <svg viewBox={`0 0 ${hw} ${hh}`} className="w-full h-11">
            <line x1="0" y1={hh - 4} x2={hw} y2={hh - 4} stroke="rgba(103,232,249,0.12)" strokeWidth="1" />
            <path d={rssiPath} fill="none" stroke="#38d7ff" strokeWidth="1.6"
              style={{ filter: "drop-shadow(0 0 4px rgba(56,215,255,0.55))" }} />
            {pts.map((p, i) => {
              const x = (i / (pts.length - 1)) * hw;
              const t = (p.rssi - rssiMin) / span;
              const y = hh - t * (hh - 8) - 4;
              return <circle key={i} cx={x} cy={y} r={2} fill="#67e8f9" />;
            })}
          </svg>
        ) : (
          <p className="text-[10px] text-slate-600 h-11 flex items-center">Waiting for enough packets to plot a real RSSI trend...</p>
        )}
      </div>
    </div>
  );
}


/* ---------------- Real 2D map (actual OpenStreetMap tiles via react-leaflet) ---------------- */
function FlyTo({ target, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lon], zoom || 15, { duration: 1.1 });
  }, [target?.lat, target?.lon, zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}


/* Battery-driven urgency, red-scale only (acknowledged pins turn green elsewhere and are
   never affected by this). A fading beacon is more time-critical to reach, so lower
   battery reads as a deeper, more saturated red with a stronger pulse — not a different
   hue, just more intense along the same red scale so "red = pending SOS" stays consistent. */
function batteryRedShade(battery) {
  if (battery == null) return "#f87171";       // unknown battery — default (healthy-looking) red
  if (battery <= 20) return "#b91c1c";          // critical — deep, saturated red
  if (battery <= 50) return "#ef4444";          // low — mid red
  return "#f87171";                             // healthy — lighter red
}
function batteryIntensity(battery) {
  if (battery == null) return 1;
  if (battery <= 20) return 1.35;               // bigger, brighter pulse ring
  if (battery <= 50) return 1.15;
  return 1;
}


/* Sharper, higher-contrast marker: pin silhouette + a clearly visible double
   radar-pulse ring + status glyph. Acknowledged pins get a check-mark glyph
   and switch to solid green with no pulse (resolved); pending pins keep a
   bold, unmistakable red pulsing radar ring so they can't be missed on the map —
   and that ring's shade/size now scales with the device's reported battery. */
function pinIcon(color, { pulse = false, label, acknowledged = false, intensity = 1 } = {}) {
  const glyph = acknowledged
    ? `<path d="M12.5 17.2l2.9 2.9 6.1-6.3" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<rect x="16" y="10.5" width="2.2" height="8" rx="1.1" fill="#ffffff"/><circle cx="17.1" cy="21.6" r="1.35" fill="#ffffff"/>`;
  const ringSize = Math.round(30 * intensity);
  const ringTop = Math.round(9 - (ringSize - 30) / 2);
  const glowPx = Math.round(6 * intensity);
  const html = `
    <div style="position:relative;width:46px;height:56px;display:flex;align-items:center;justify-content:center;transform:translate(-4px,-10px);">
      ${pulse ? `
        <div style="position:absolute;top:${ringTop}px;width:${ringSize}px;height:${ringSize}px;border-radius:50%;background:${color}55;border:2px solid ${color};animation:pinPulse 1.5s ease-out infinite;"></div>
        <div style="position:absolute;top:${ringTop}px;width:${ringSize}px;height:${ringSize}px;border-radius:50%;background:${color}55;border:2px solid ${color};animation:pinPulse 1.5s ease-out 0.5s infinite;"></div>
      ` : ""}
      <svg width="40" height="50" viewBox="0 0 34 44" style="position:relative;z-index:2;filter:drop-shadow(0 3px ${glowPx}px rgba(0,0,0,0.7)) drop-shadow(0 0 ${glowPx}px ${color}aa);">
        <path d="M17 1C8.16 1 1 8.16 1 17c0 12 16 26 16 26s16-14 16-26C33 8.16 25.84 1 17 1z"
          fill="${color}" stroke="#0a1626" stroke-width="2.2"/>
        <path d="M17 1C8.16 1 1 8.16 1 17c0 12 16 26 16 26s16-14 16-26C33 8.16 25.84 1 17 1z"
          fill="none" stroke="#ffffff" stroke-width="1.4" opacity="0.9"/>
        <circle cx="17" cy="17" r="8.8" fill="rgba(0,0,0,0.3)"/>
        <circle cx="17" cy="17" r="8.8" fill="none" stroke="#ffffff" stroke-width="1.3"/>
        ${glyph}
      </svg>
      ${label ? `<div style="position:absolute;top:-6px;z-index:3;background:#0a1626;border:1.5px solid ${color};color:#fff;font:700 9px monospace;padding:1.5px 5px;border-radius:5px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.6);">${label}</div>` : ""}
    </div>
    <style>@keyframes pinPulse { 0% { transform: scale(0.6); opacity: 0.95;} 100% { transform: scale(2.6); opacity: 0;} }</style>
  `;
  return L.divIcon({ className: "", html, iconSize: [46, 56], iconAnchor: [23, 50], popupAnchor: [0, -44] });
}


function RealMap({ pins = [], focus, zoom = 12, onPinClick, onAck, height = "100%" }) {
  const withGps = useMemo(() => pins.filter((p) => p.lat != null && p.lon != null), [pins]);
  const center = focus ? [focus.lat, focus.lon] : [GROUND_STATION.lat, GROUND_STATION.lon];


  return (
    <div className="map-dark relative rounded-xl overflow-hidden border border-cyan-400/15" style={{ width: "100%", height }}>
      <MapContainer center={center} zoom={focus ? zoom : 9} style={{ width: "100%", height: "100%" }} scrollWheelZoom>
        <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {withGps.map((p) => {
          const acked = p.status === "acknowledged";
          const color = acked ? "#34d399" : batteryRedShade(p.battery);
          const label = p.battery != null ? `${p.deviceId} · ${p.battery}%` : `${p.deviceId}`;
          return (
            <Marker key={p.id} position={[p.lat, p.lon]}
              icon={pinIcon(color, { pulse: !acked, label, acknowledged: acked, intensity: acked ? 1 : batteryIntensity(p.battery) })}
              eventHandlers={{ click: () => onPinClick && onPinClick(p) }}>
              {/* Clicking the pin only opens this info box — the marker itself never moves. */}
              <Popup autoPan={false} closeButton={true} offset={[0, -36]} minWidth={230}>
                <div className="text-[11px] font-mono leading-relaxed">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-semibold text-[12px]">{p.deviceId} · {p.deviceName}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wide ${acked ? "bg-emerald-500 text-white" : "bg-red-500 text-white"}`}>
                      {acked ? "Acknowledged" : "Pending"}
                    </span>
                  </div>
                  <div className="mb-0.5">Lat/Lon: {Number(p.lat).toFixed(6)}, {Number(p.lon).toFixed(6)}</div>
                  {p.altitude != null && <div className="mb-0.5">Altitude: {p.altitude} m</div>}
                  {p.battery != null && <div className="mb-0.5">Battery: {p.battery}%{!acked && p.battery <= 20 ? " — critical, prioritize" : ""}</div>}
                  <div className="text-slate-500 mb-2">{p.alertType || "SOS"} · Msg #{p.messageId ?? p.sequenceNo ?? "—"}</div>
                  {!acked && onAck && (
                    <button
                      onClick={() => onAck(p.id)}
                      className="w-full flex items-center justify-center gap-1.5 text-[11px] font-medium py-1.5 rounded-lg border border-emerald-400/50 text-emerald-300 hover:bg-emerald-400/10 transition-colors"
                    >
                      ✓ Acknowledge
                    </button>
                  )}
                  {acked && (
                    <div className="w-full flex items-center justify-center gap-1.5 text-[11px] font-medium py-1.5 rounded-lg bg-emerald-500 text-white">
                      ✓ Acknowledged
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}
        {focus && <FlyTo target={focus} zoom={zoom} />}
      </MapContainer>
      {withGps.length === 0 && !focus && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs pointer-events-none bg-[#040b16]/60">
          No GPS-valid packets yet.
        </div>
      )}
      <style>{`
        .map-dark .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.9) saturate(0.7); }
        .map-dark .leaflet-container { background:#040b16; font-family: inherit; }
        .map-dark .leaflet-control-attribution { background: rgba(4,11,22,0.7); color:#64748b; }
        .map-dark .leaflet-control-zoom a { background:#0a1626; color:#67e8f9; border-color: rgba(103,232,249,0.2); }
        .map-dark .leaflet-popup-content-wrapper { background:#0a1626; color:#e2e8f0; border:1px solid rgba(103,232,249,0.3); border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.5); }
        .map-dark .leaflet-popup-content { margin:12px 14px; min-width:220px; }
        .map-dark .leaflet-popup-tip { background:#0a1626; border:1px solid rgba(103,232,249,0.3); }
        .map-dark .leaflet-popup-close-button { color:#67e8f9 !important; }
      `}</style>
    </div>
  );
}


/* ---------------- Full-screen exact location view (real map + a static fix readout) ---------------- */
function LocationView({ alert, onBack }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);
  if (!alert || alert.lat == null || alert.lon == null) return null;


  return (
    <div className={`fixed inset-0 z-[60] bg-[#020814] transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}>
      <div className="h-full w-full flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-cyan-400/15 bg-white/[0.02] gap-3">
          <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-cyan-300 hover:text-cyan-100">
            <ArrowLeft size={14} /> Back to Mission Control
          </button>
          <div className="text-xs text-slate-400 flex items-center gap-2 truncate">
            <MapPin size={13} className="text-red-400 shrink-0" />
            {alert.deviceName || alert.deviceId} · {Number(alert.lat).toFixed(5)}, {Number(alert.lon).toFixed(5)}
          </div>
        </div>
        <div className="flex-1 p-4 flex flex-col gap-4 overflow-y-auto">
          <div style={{ height: "62%", minHeight: 280 }}>
            <RealMap pins={[alert]} focus={alert} zoom={16} height="100%" />
          </div>
          {/* Static fix readout — no scrubber/playback, just the current values for this device. */}
          <div className="bg-white/[0.03] border border-cyan-400/15 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-cyan-300 text-xs tracking-widest uppercase mb-3">
              <Clock size={14} /> Live Location Feed
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="bg-black/30 rounded-lg px-2.5 py-2">
                <p className="text-[9px] text-slate-500 uppercase mb-0.5">Time</p>
                <p className="text-white font-mono">{new Date(alert.receivedAt).toLocaleTimeString()}</p>
              </div>
              <div className="bg-black/30 rounded-lg px-2.5 py-2">
                <p className="text-[9px] text-slate-500 uppercase mb-0.5">Location</p>
                <p className="text-white font-mono">{Number(alert.lat).toFixed(4)}, {Number(alert.lon).toFixed(4)}</p>
              </div>
              <div className="bg-black/30 rounded-lg px-2.5 py-2">
                <p className="text-[9px] text-slate-500 uppercase mb-0.5">Signal</p>
                <p className="text-white font-mono">{alert.rssi ?? "—"} dBm</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ---------------- Smart automatic alerts panel ---------------- */
function SystemAlertsPanel({ alerts }) {
  const styles = {
    "signal-drop": { icon: <Signal size={13} className="text-red-400" />, cls: "border-red-400/30 text-red-300 bg-red-400/5" },
    "signal-restored": { icon: <Signal size={13} className="text-emerald-400" />, cls: "border-emerald-400/30 text-emerald-300 bg-emerald-400/5" },
    offline: { icon: <WifiOff size={13} className="text-amber-400" />, cls: "border-amber-400/30 text-amber-300 bg-amber-400/5" },
    "not-moving": { icon: <MapPin size={13} className="text-cyan-400" />, cls: "border-cyan-400/30 text-cyan-300 bg-cyan-400/5" },
  };


  return (
    <div className="bg-white/[0.03] border border-cyan-400/15 rounded-2xl p-4">
      <div className="flex items-center gap-2 text-cyan-300 text-xs tracking-widest uppercase mb-3">
        <AlertTriangle size={14} /> Smart Alerts
      </div>
      {alerts.length === 0 ? (
        <p className="text-[11px] text-slate-500">No anomalies detected. All devices nominal.</p>
      ) : (
        <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
          {alerts.map((sa) => {
            const s = styles[sa.type] || styles["not-moving"];
            return (
              <div key={sa.id} className={`flex items-start gap-2 text-[11px] rounded-lg border px-2.5 py-2 ${s.cls}`}>
                {s.icon}
                <div className="flex-1">
                  <p className="leading-snug">{sa.message}</p>
                  <p className="text-[9px] text-slate-500 mt-0.5">Device {sa.deviceId} · {new Date(sa.at).toLocaleTimeString()}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


/* ---------------- Device activity summary (speed / direction / distance) ---------------- */
function DeviceActivitySummary({ metrics, deviceId, deviceName }) {
  if (!metrics) {
    return (
      <div className="bg-white/[0.03] border border-cyan-400/15 rounded-2xl p-4">
        <div className="flex items-center gap-2 text-cyan-300 text-xs tracking-widest uppercase mb-2">
          <TrendingUp size={14} /> Device Activity
        </div>
        <p className="text-[11px] text-slate-500">No GPS-valid packets yet.</p>
      </div>
    );
  }


  const isActive = metrics.secondsSinceUpdate < 120;


  return (
    <div className="bg-white/[0.03] border border-cyan-400/15 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-cyan-300 text-xs tracking-widest uppercase">
          <TrendingUp size={14} /> Device Activity
        </div>
        <span className={`text-[9px] px-2 py-0.5 rounded-full border tracking-widest uppercase ${isActive ? "text-emerald-300 border-emerald-400/40 bg-emerald-400/10" : "text-amber-300 border-amber-400/40 bg-amber-400/10"}`}>
          {isActive ? "Active" : "Idle"}
        </span>
      </div>
      <p className="text-[10px] text-slate-500 mb-3">Device {deviceId} · {deviceName}</p>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="bg-black/30 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-slate-500 uppercase mb-0.5">Location</p>
          <p className="text-white font-mono">{metrics.last.lat.toFixed(4)}, {metrics.last.lon.toFixed(4)}</p>
        </div>
        <div className="bg-black/30 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-slate-500 uppercase mb-0.5">Last Updated</p>
          <p className="text-white font-mono">{metrics.secondsSinceUpdate}s ago</p>
        </div>
        <div className="bg-black/30 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-slate-500 uppercase mb-0.5">Speed</p>
          <p className="text-white font-mono">{metrics.speedKmh.toFixed(1)} km/h</p>
        </div>
        <div className="bg-black/30 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-slate-500 uppercase mb-0.5">Direction</p>
          <p className="text-white font-mono">{metrics.direction != null ? compassLabel(metrics.direction) : "—"}</p>
        </div>
        <div className="bg-black/30 rounded-lg px-2.5 py-2 col-span-2">
          <p className="text-[9px] text-slate-500 uppercase mb-0.5">Total Distance Tracked</p>
          <p className="text-white font-mono">{metrics.totalDistanceKm.toFixed(2)} km</p>
        </div>
      </div>
    </div>
  );
}


/* ---------------- Dashboard ---------------- */
/* ---------------- Navigate-to-location transition overlay ----------------
   Translucent full-screen popup shown for the ~1.5s between the user
   clicking "View Location"/"Map" and the exact-location map appearing.
   Reuses the orbit animation so the satellite pass feels like it's actively
   relaying the fix down to the ground station, rather than a blank wait. ---------------- */
function NavTransitionOverlay({ target }) {
  if (!target) return null;
  return (
    <div className="fixed inset-0 z-[70] bg-[#020814]/75 backdrop-blur-md flex flex-col items-center justify-center animate-[fadeIn_0.25s_ease-out]">
      <OrbitScene size={230} />
      <div className="mt-2 w-72 text-center">
        <div className="flex items-center justify-center gap-2 text-cyan-300 text-[11px] tracking-widest uppercase mb-1">
          <Navigation size={12} className="animate-pulse" /> Navigating to location...
        </div>
        <p className="text-white text-sm font-mono">
          {target.lat != null ? `${Number(target.lat).toFixed(5)}, ${Number(target.lon).toFixed(5)}` : "—"}
        </p>
        <p className="text-[10px] text-slate-500 mt-0.5">{target.deviceName || target.deviceId}</p>
        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden mt-3">
          <div className="h-full bg-cyan-400" style={{ animation: "navProgress 1.5s linear forwards", boxShadow: "0 0 8px rgba(56,215,255,0.7)" }} />
        </div>
      </div>
      <style>{`
        @keyframes navProgress { from { width: 0%; } to { width: 100%; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </div>
  );
}


function Dashboard({ operator }) {
  const { connected, latest, history } = useGroundStation();
  const fallbackAlerts = useFallbackAlerts(!connected);
  const [localAlerts, setLocalAlerts] = useState({}); // id -> {status, ackAt}
  const [tab, setTab] = useState("all");
  const [view, setView] = useState("queue");
  const [modalAlert, setModalAlert] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [clock, setClock] = useState(new Date());
  const [signalActive, setSignalActive] = useState(false);
  const [navTarget, setNavTarget] = useState(null);
  const [locationTarget, setLocationTarget] = useState(null);
  const lastSeenId = useRef(null);


  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);


  useEffect(() => {
    if (latest && latest.id !== lastSeenId.current) {
      lastSeenId.current = latest.id;
      setSignalActive(true);
      setTimeout(() => setSignalActive(false), 2200);
    }
  }, [latest]);


  const alerts = useMemo(() => {
    const real = history.length ? history : latest ? [latest] : [];
    const merged = connected && real.length ? real : fallbackAlerts;
    return merged.map((a) => ({ ...a, ...(localAlerts[a.id] || {}) }));
  }, [history, latest, localAlerts, connected, fallbackAlerts]);


  const displayLatest = connected ? latest : fallbackAlerts[0];


  const deviceTracks = useDeviceTracks(alerts);
  const systemAlerts = useSmartAlerts(alerts);


  const activeDeviceId = displayLatest?.deviceId ?? alerts[0]?.deviceId ?? null;
  const activeDeviceName = displayLatest?.deviceName ?? alerts[0]?.deviceName ?? "—";
  const activeTrack = activeDeviceId != null ? (deviceTracks[activeDeviceId] || []) : [];
  const activeMetrics = computeDeviceMetrics(activeTrack);


  // Real RSSI history for the "Incoming Signal Strength" panel — the last several
  // decoded packets (any device), oldest to newest, so the trend line moves only
  // when genuine telemetry arrives.
  const recentSignal = useMemo(
    () => [...alerts].sort((a, b) => a.receivedAt - b.receivedAt).slice(-20),
    [alerts]
  );


  const filtered = useMemo(() => {
    if (tab === "recent") return alerts.filter((a) => a.status === "new");
    if (tab === "responded") return alerts.filter((a) => a.status !== "new");
    return alerts;
  }, [alerts, tab]);


  const acknowledge = (id) => {
    setLocalAlerts((prev) => ({ ...prev, [id]: { ...prev[id], status: "acknowledged", ackAt: Date.now() } }));
    const a = alerts.find((x) => x.id === id);
    const key = `${id}-${Date.now()}`;
    setToasts((prev) => [...prev, { key, deviceId: a?.deviceId ?? "—" }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.key !== key)), 4500);
    setModalAlert((m) => (m && m.id === id ? { ...m, status: "acknowledged", ackAt: Date.now() } : m));
  };


  const viewLocation = (alert) => {
    setModalAlert(null);
    setNavTarget(alert);
    setTimeout(() => {
      setLocationTarget(alert);
      setNavTarget(null);
    }, 1500);
  };


  const counts = {
    all: alerts.length,
    recent: alerts.filter((a) => a.status === "new").length,
    responded: alerts.filter((a) => a.status !== "new").length,
  };


  return (
    <div className="min-h-screen w-full bg-[#020814] text-slate-200 relative overflow-hidden font-[Inter,sans-serif]">
      <Starfield />


      <header className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-cyan-400/10 bg-white/[0.02] backdrop-blur">
        <div className="flex items-center gap-3">
          <Earth size={40} />
          <div>
            <h1 className="text-white text-sm tracking-[0.25em] font-semibold">ORBITAL SOS</h1>
            <p className="text-[10px] tracking-[0.3em] text-cyan-400/70 uppercase">Mission Control</p>
          </div>
        </div>
        <div className="flex items-center gap-6 text-xs text-slate-400">
          {operator && (
            <div className="flex items-center gap-1.5 text-[11px] text-cyan-200">
              <User size={12} className="text-cyan-400" />
              {operator.name} <span className="text-slate-500 font-mono">// {operator.codename}</span>
            </div>
          )}
          <LinkBadge connected={connected} />
          <div className="flex items-center gap-1.5"><Globe2 size={13} className="text-cyan-400" /> 868.10 MHz</div>
          <div className="flex flex-col items-end leading-tight">
            <span className="font-mono text-cyan-200">{clock.toLocaleTimeString()}</span>
            <span className="font-mono text-[10px] text-slate-500">
              {clock.toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "short", year: "numeric" })}
            </span>
          </div>
        </div>
      </header>


      <div className="relative z-10 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5 p-5">
        <div className="flex flex-col gap-5">
          <div className="bg-white/[0.03] border border-red-400/30 rounded-2xl p-4 shadow-[0_0_30px_rgba(239,68,68,0.12)]">
            <div className="flex items-center gap-2 text-red-400 text-xs tracking-widest uppercase mb-2">
              <AlertTriangle size={14} /> New Alert Received
            </div>
            {displayLatest ? (
              <>
                <div className="flex items-center gap-1.5 text-white text-sm mb-1">
                  <MapPin size={14} className="text-cyan-400" /> {displayLatest.lat != null ? `${displayLatest.lat}, ${displayLatest.lon}` : "GPS unavailable"}
                </div>
                <p className="text-[11px] text-slate-500 mb-3">{displayLatest.deviceName} · {displayLatest.alertType} · Msg #{displayLatest.messageId}</p>
                <button onClick={() => setModalAlert({ ...displayLatest, ...(localAlerts[displayLatest.id] || {}) })} className="text-[11px] tracking-wide text-cyan-300 hover:text-cyan-100 flex items-center gap-1">
                  Tap for more info <ChevronRight size={12} />
                </button>
              </>
            ) : (
              <p className="text-[11px] text-slate-500">Waiting for the first decoded packet...</p>
            )}
          </div>


          <div className="bg-white/[0.03] border border-cyan-400/15 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-cyan-300 text-xs tracking-widest uppercase mb-3">
              <Signal size={14} /> Incoming Signal Strength
            </div>
            <Waveform active={signalActive || !connected} history={recentSignal} />
            <div className="flex justify-between mt-2 text-[10px] text-slate-500 font-mono">
              <span>RSSI {displayLatest?.rssi ?? "--"} dBm</span>
              <span>SNR {displayLatest?.snr ?? "--"} dB</span>
            </div>
          </div>


          <div className="bg-white/[0.03] border border-cyan-400/15 rounded-2xl p-4 grid grid-cols-3 gap-2 text-center">
            <div><p className="text-lg text-white font-semibold">{counts.all}</p><p className="text-[10px] text-slate-500 tracking-wider uppercase">Total</p></div>
            <div><p className="text-lg text-cyan-300 font-semibold">{counts.recent}</p><p className="text-[10px] text-slate-500 tracking-wider uppercase">Pending</p></div>
            <div><p className="text-lg text-emerald-400 font-semibold">{counts.responded}</p><p className="text-[10px] text-slate-500 tracking-wider uppercase">Handled</p></div>
          </div>


          <SystemAlertsPanel alerts={systemAlerts} />


          <DeviceActivitySummary metrics={activeMetrics} deviceId={activeDeviceId ?? "—"} deviceName={activeDeviceName} />
        </div>


        <div className="bg-white/[0.03] border border-cyan-400/15 rounded-2xl overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 pt-4">
            <div className="flex items-center gap-1">
              {[["all", "All"], ["recent", "Recent"], ["responded", "Responded"]].map(([key, label]) => (
                <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs tracking-wide rounded-t-lg border-b-2 transition-colors ${tab === key ? "text-cyan-300 border-cyan-400" : "text-slate-500 border-transparent hover:text-slate-300"}`}>
                  {label} <span className="text-slate-600">({counts[key]})</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 bg-black/30 rounded-lg p-1 mb-2">
              <button onClick={() => setView("queue")} className={`p-1.5 rounded-md transition-colors ${view === "queue" ? "bg-cyan-400 text-[#02121f]" : "text-slate-400 hover:text-white"}`}><List size={14} /></button>
              <button onClick={() => setView("map")} className={`p-1.5 rounded-md transition-colors ${view === "map" ? "bg-cyan-400 text-[#02121f]" : "text-slate-400 hover:text-white"}`}><MapIcon size={14} /></button>
            </div>
          </div>


          {view === "map" ? (
            <div className="p-4 flex-1"><RealMap pins={filtered} onAck={acknowledge} height="100%" /></div>
          ) : (
            <div className="overflow-x-auto px-2 pb-2 flex-1">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-[10px] tracking-widest text-slate-500 uppercase">
                    <th className="px-3 py-2 font-medium">Device</th>
                    <th className="px-3 py-2 font-medium">Alert Type</th>
                    <th className="px-3 py-2 font-medium">Received</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.id} className="border-t border-white/5 hover:bg-cyan-400/[0.04] transition-colors">
                      <td className="px-3 py-3">
                        <div className="text-white text-xs flex items-center gap-1.5">
                          {a.deviceId} · {a.deviceName}
                        </div>
                        <div className="text-slate-500 text-[11px] flex items-center gap-1"><MapPin size={10} /> {a.lat != null ? `${a.lat}, ${a.lon}` : "no GPS fix"}</div>
                      </td>
                      <td className="px-3 py-3">
                        <span className={`text-[10px] px-2 py-1 rounded-full border tracking-wide ${a.alertType === "CRITICAL_SOS" || a.alertType === "SOS" ? "bg-red-500/15 text-red-400 border-red-400/30" : "bg-emerald-500/15 text-emerald-400 border-emerald-400/30"}`}>{a.alertType}</span>
                      </td>
                      <td className="px-3 py-3 text-slate-400 text-[11px] font-mono">{new Date(a.receivedAt).toLocaleTimeString()}</td>
                      <td className="px-3 py-3">
                        {a.status === "acknowledged" ? (
                          <span className="flex items-center gap-1 text-[11px] text-white bg-emerald-500 px-2 py-1 rounded-full w-fit"><ShieldCheck size={12} /> Acknowledged</span>
                        ) : (
                          <span className="flex items-center gap-1 text-cyan-300 text-[11px]"><Loader2 size={12} className="animate-spin" /> Awaiting</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-2">
                          <button onClick={() => setModalAlert(a)} className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg border border-cyan-400/30 text-cyan-300 hover:bg-cyan-400/10 transition-colors"><Eye size={12} /> Details</button>
                          <button disabled={a.lat == null} onClick={() => viewLocation(a)} className={`flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg border transition-colors ${a.lat == null ? "border-white/10 text-slate-600 cursor-not-allowed" : "border-cyan-400/30 text-cyan-300 hover:bg-cyan-400/10"}`}><MapPin size={12} /> Map</button>
                          <button disabled={a.status !== "new"} onClick={() => acknowledge(a.id)} className={`flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg transition-colors font-medium ${a.status === "acknowledged" ? "bg-emerald-500 text-white cursor-default" : a.status !== "new" ? "border border-white/10 text-slate-600 cursor-not-allowed" : "bg-cyan-400 text-[#02121f] hover:bg-cyan-300"}`}><Users size={12} /> {a.status === "acknowledged" ? "Acknowledged" : "Acknowledge"}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={5} className="text-center text-slate-600 text-xs py-10">No packets received yet — waiting on the ground station.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>


      {modalAlert && <DetailsModal alert={modalAlert} onClose={() => setModalAlert(null)} onAck={acknowledge} onViewLocation={viewLocation} />}
      <NavTransitionOverlay target={navTarget} />
      {locationTarget && (
        <LocationView
          alert={locationTarget}
          onBack={() => setLocationTarget(null)}
        />
      )}
      <AckToast toasts={toasts} />
    </div>
  );
}


/* ---------------- Root ---------------- */
export default function OrbitalControlRoom() {
  const [screen, setScreen] = useState("login");
  const [operator, setOperator] = useState(null);
  const { connected } = useGroundStation();
  if (screen === "login") return <LoginScreen onSubmit={(op) => { setOperator(op); setScreen("transition"); }} connected={connected} />;
  if (screen === "transition") return <UplinkTransition onComplete={() => setScreen("dashboard")} />;
  return <Dashboard operator={operator} />;
}