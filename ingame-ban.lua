-- Overclock - in-game enforcement + live stats board (WebSocket)
-- Connects to the VPS api.js over WebSocket:
--   * pushes live player stats every TICK_INTERVAL (board updates ~5s)
--   * receives bans / announcements / commands instantly via push
--   * manages the Server MVP cape (re-applied every second)
-- Config:
local WS_URL = "ws://217.156.65.201:3000/ws?token=85TRJDIO98UTDFIJOUR87YGFDUISUEW8R7YHDFJISW8EU7RYFDJIS8EUEW7892384754839EWIDJFHGYREUIJFV&role=lua" -- VPS api.js; token must match VPS .env API_TOKEN
local TICK_INTERVAL = 5 -- seconds between live stats posts (Discord board updates ~5s)
local COMMAND_DELAY = 0.5 -- seconds between dependent commands (:uncape before :cape)
local CAPE_REAPPLY_INTERVAL = 1 -- seconds; re-applies the cape to the current MVP in case they reset and lose it

-- The command bar number changes every server update.
-- Get it manually, then update commandbarnum here and re-execute.
local commandbarnum = "41111342434KCmdBar"

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local function log(msg)
  print("[Overclock] " .. msg)
end

local function getRemote()
  return game:GetService("ReplicatedStorage")["b\007\010\007\010\007"]
end

local ws = nil
local connected = false
local reconnecting = false
local warnedOffline = false
local banned = {}
local wasOnline = {}
local lastAnnouncementId = 0
local lastCommandId = 0
local currentMvp = nil
local lastNotifiedMvp = nil

local function fire(cmd)
  local ok, err = pcall(function()
    getRemote():FireServer(commandbarnum, cmd)
  end)
  if ok then
    log("fire: \"" .. cmd .. "\"")
  else
    warn("[Overclock] fire failed: " .. tostring(err))
  end
end

-- fires "cmd|ms|cmd|ms" sequences from the command queue, e.g. ":freaky 255 255 255|1000|:freaky 0 0 0"
local function fireSequence(seq)
  for part in string.gmatch(seq, "[^|]+") do
    local trimmed = part:gsub("^%s+", ""):gsub("%s+$", "")
    local ms = tonumber(trimmed)
    if ms then
      task.wait(ms / 1000)
    elseif #trimmed > 0 then
      fire(trimmed)
    end
  end
end

local function setBans(list)
  banned = {}
  if type(list) == "table" then
    for _, row in ipairs(list) do
      if row and row.name then banned[row.name] = true end
    end
  end
  local n = 0
  for _ in pairs(banned) do n = n + 1 end
  log("bans updated: " .. n .. " banned")
end

local function handleMessage(raw)
  local ok, msg = pcall(function()
    return HttpService:JSONDecode(raw)
  end)
  if not ok or type(msg) ~= "table" or not msg.type then return end

  if msg.type == "init" then
    connected = true
    setBans(msg.bans)
    if msg.announcement and msg.announcement.id then
      lastAnnouncementId = msg.announcement.id
    end
    if msg.command and msg.command.id then
      lastCommandId = msg.command.id
    end
    log("Connected (lastAnnounced=" .. lastAnnouncementId .. ", lastCmd=" .. lastCommandId .. ")")

  elseif msg.type == "announcement" and msg.id and msg.text and msg.id > lastAnnouncementId then
    log("Announcement id=" .. msg.id .. " (last=" .. lastAnnouncementId .. "), announcing")
    fire(":announce " .. msg.text)
    lastAnnouncementId = msg.id

  elseif msg.type == "command" and msg.id and msg.command and msg.id > lastCommandId then
    log("Command id=" .. msg.id .. " (last=" .. lastCommandId .. "), firing")
    task.spawn(fireSequence, msg.command)
    lastCommandId = msg.id

  elseif msg.type == "bans" then
    setBans(msg.bans)
  end
end

local function scheduleReconnect()
  if reconnecting then return end
  reconnecting = true
  task.spawn(function()
    task.wait(5)
    reconnecting = false
    if not connected then
      log("Reconnecting...")
      connect()
    end
  end)
end

function connect()
  local ok, err = pcall(function()
    ws = WebSocket.connect(WS_URL)
    ws.OnMessage:Connect(handleMessage)
    ws.OnClose:Connect(function()
      log("WebSocket closed")
      connected = false
      ws = nil
      scheduleReconnect()
    end)
  end)
  if not ok then
    warn("[Overclock] WebSocket connect failed: " .. tostring(err))
    connected = false
    ws = nil
    scheduleReconnect()
  end
end

local function sendSnapshot(players, mvp)
  if not connected or not ws then
    if not warnedOffline then
      warn("[Overclock] ws not connected - skipping snapshot")
      warnedOffline = true
    end
    return
  end
  warnedOffline = false
  local ok, err = pcall(function()
    ws:Send(HttpService:JSONEncode({
      type = "snapshot",
      data = { players = players, mvp = mvp, ts = os.time() },
    }))
  end)
  if ok then
    log("Snapshot sent: " .. #players .. " players, mvp=" .. tostring(mvp))
  else
    warn("[Overclock] snapshot send failed: " .. tostring(err))
  end
end

local function readStat(player, name)
  local ls = player:FindFirstChild("leaderstats")
  if not ls then return 0 end
  local stat = ls:FindFirstChild(name)
  if not stat then
    warn("[Overclock] readStat: " .. player.Name .. " has no \"" .. name .. "\" stat")
    return 0
  end
  local v = tonumber(stat.Value)
  return v or 0
end

local function collectPlayers()
  local list = {}
  local mvp, mvpKills = nil, -1
  local tied = false
  for _, player in ipairs(Players:GetPlayers()) do
    local kills = readStat(player, "Kills")
    local entry = {
      name = player.Name,
      kills = kills,
      deaths = readStat(player, "Deaths"),
      damage = readStat(player, "Damage"),
      heal = readStat(player, "Heal"),
    }
    table.insert(list, entry)
    if kills > mvpKills then
      mvpKills = kills
      mvp = player.Name
      tied = false
    elseif kills == mvpKills then
      tied = true
    end
  end
  -- MVP only if one player is strictly ahead with at least 1 kill
  if tied or mvpKills < 1 then
    log("collectPlayers: " .. #list .. " players, mvp=none (tied=" .. tostring(tied) .. ", topKills=" .. mvpKills .. ")")
    return list, nil
  end
  log("collectPlayers: " .. #list .. " players, mvp=" .. mvp .. " (" .. mvpKills .. " kills)")
  return list, mvp
end

log("Starting Overclock script (tick=" .. TICK_INTERVAL .. "s)")
connect()

-- re-apply the cape to the current MVP every second (they lose it on reset),
-- so the cape is always on exactly one player: the MVP
task.spawn(function()
  while true do
    task.wait(CAPE_REAPPLY_INTERVAL)
    if currentMvp then
      fire(":cape " .. currentMvp)
    end
  end
end)

while true do
  log("--- tick (" .. #Players:GetPlayers() .. " players online) ---")

  -- 1) live stats + MVP cape posted FIRST so the board always gets fresh data
  local ok3, players, mvp = pcall(function()
    return collectPlayers()
  end)
  if ok3 then
    if mvp then
      if currentMvp ~= mvp then
        local old = currentMvp
        currentMvp = mvp
        if old then
          log("Removing cape from old MVP " .. old)
          fire(":uncape " .. old)
          task.wait(COMMAND_DELAY)
        end
        log("Giving cape to new MVP " .. mvp)
        fire(":cape " .. mvp)
        task.wait(COMMAND_DELAY)
      end
    elseif currentMvp then
      local old = currentMvp
      currentMvp = nil
      log("No MVP anymore, removing cape from " .. old)
      fire(":uncape " .. old)
      task.wait(COMMAND_DELAY)
    end

    -- notify only when the MVP changes (new MVP, or MVP removed)
    if mvp ~= lastNotifiedMvp then
      local text = "TYPE IN CHAT FOR GUN/MAP CHANGE. Current Server MVP: " .. (mvp or "none")
      fire(":n " .. text)
      lastNotifiedMvp = mvp
      log("Notified (mvp=" .. tostring(mvp) .. ")")
    end

    sendSnapshot(players, mvp)
  else
    warn("[Overclock] tick: collectPlayers error")
  end

  -- 2) persistent bans - every tick (re-ban banned players on fresh join)
  local nowOnline = {}
  for _, player in ipairs(Players:GetPlayers()) do
    local name = player.Name
    nowOnline[name] = true
    if banned[name] and not wasOnline[name] then
      fire(":ban " .. player.Name)
      log("Auto-banned " .. player.Name)
    end
  end
  wasOnline = nowOnline

  task.wait(TICK_INTERVAL)
end
