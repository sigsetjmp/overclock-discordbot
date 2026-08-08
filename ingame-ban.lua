-- Overclock - in-game enforcement + live stats board
-- Talks to the VPS API (api.js) for bans/announcements/commands and
-- posts live player stats over REST. The Discord bot gets real-time
-- updates via WebSocket from the same API.
-- Config:
local BASE_URL = "http://YOUR_VPS_IP_OR_DOMAIN:3000" -- VPS address of the overclock API
local API_TOKEN = "set-me" -- must match API_TOKEN in the VPS .env
local POLL_INTERVAL = 3 -- seconds between full syncs (bans/announcements/stats)
local COMMAND_DELAY = 0.5 -- seconds between dependent commands (:uncape before :cape)
local CAPE_REAPPLY_INTERVAL = 1 -- seconds; re-applies the cape to the current MVP in case they reset and lose it
local NOTIFY_INTERVAL = 30 -- seconds between :n notify messages (separate from the sync)

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

local function get(url)
  local t0 = os.clock()
  local res = request({
    Url = url,
    Method = "GET",
    Timeout = 2,
    Headers = {
      ["x-api-token"] = API_TOKEN,
    },
  })
  local ms = math.floor((os.clock() - t0) * 1000)
  if not res then
    warn("[Overclock] GET (" .. ms .. "ms) nil response: " .. url)
    return nil
  end
  if not res.Success then
    warn("[Overclock] GET (" .. ms .. "ms) failed (" .. tostring(res.StatusCode) .. "): " .. url)
    return nil
  end
  log("GET (" .. ms .. "ms): " .. url)
  return HttpService:JSONDecode(res.Body)
end

local function post(url, body)
  local t0 = os.clock()
  local res = request({
    Url = url,
    Method = "POST",
    Timeout = 2,
    Headers = {
      ["x-api-token"] = API_TOKEN,
      ["Content-Type"] = "application/json",
    },
    Body = HttpService:JSONEncode(body),
  })
  local ms = math.floor((os.clock() - t0) * 1000)
  if not res or not res.Success then
    warn("[Overclock] POST (" .. ms .. "ms) failed (" .. tostring(res and res.StatusCode or "no response") .. "): " .. url)
    return false
  end
  log("POST (" .. ms .. "ms): " .. url)
  return true
end

local function fetchBannedNames()
  local data = get(BASE_URL .. "/bans")
  if not data then
    warn("[Overclock] fetchBannedNames: no data")
    return {}
  end
  local names = {}
  for _, row in ipairs(data) do names[row.name] = true end
  log("fetchBannedNames: " .. #data .. " bans loaded")
  return names
end

local function fetchLatestAnnouncement()
  local data = get(BASE_URL .. "/announcements/latest")
  if not data or not data.id or data.id == 0 then
    log("fetchLatestAnnouncement: none")
    return nil
  end
  log("fetchLatestAnnouncement: id=" .. data.id .. " text=\"" .. data.text .. "\"")
  return data
end

local function fetchLatestCommand()
  local data = get(BASE_URL .. "/commands/latest")
  if not data or not data.id or data.id == 0 then
    log("fetchLatestCommand: none")
    return nil
  end
  log("fetchLatestCommand: id=" .. data.id .. " command=\"" .. data.command .. "\"")
  return data
end

local function fetchState()
  local data = get(BASE_URL .. "/snapshot")
  if not data or not data.data then
    log("fetchState: no snapshot yet")
    return nil
  end
  local ok, parsed = pcall(function()
    return HttpService:JSONDecode(data.data)
  end)
  if not ok then
    warn("[Overclock] fetchState: failed to decode snapshot data")
    return nil
  end
  log("fetchState: last_announced_id=" .. tostring(parsed.last_announced_id))
  return parsed
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

log("Starting Overclock script (commandbarnum=" .. commandbarnum .. ", poll=" .. POLL_INTERVAL .. "s)")

local wasOnline = {}
local lastAnnouncementId = 0
local lastCommandId = 0
local currentMvp = nil
local lastNotify = 0

-- resume from persisted state so restarts never replay old announcements
local ok0, state = pcall(fetchState)
if ok0 and state then
  if state.last_announced_id then
    lastAnnouncementId = state.last_announced_id
    log("Resumed lastAnnouncementId=" .. lastAnnouncementId)
  end
  if state.last_command_id then
    lastCommandId = state.last_command_id
    log("Resumed lastCommandId=" .. lastCommandId)
  end
end

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

local iteration = 0
while true do
  iteration = iteration + 1
  log("--- tick " .. iteration .. " (" .. #Players:GetPlayers() .. " players online) ---")

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

    -- notify message runs on its own timer
    if os.time() - lastNotify >= NOTIFY_INTERVAL then
      local text = "TYPE IN CHAT FOR GUN/MAP CHANGE. Current Server MVP: " .. (mvp or "none")
      fire(":n " .. text)
      lastNotify = os.time()
      log("Notified (mvp=" .. tostring(mvp) .. ")")
    end

    local ok4 = post(
      BASE_URL .. "/snapshot",
      HttpService:JSONEncode({ players = players, mvp = mvp, ts = os.time(), last_announced_id = lastAnnouncementId, last_command_id = lastCommandId })
    )
    if ok4 then
      log("Snapshot posted: " .. #players .. " players, mvp=" .. tostring(mvp))
    else
      warn("[Overclock] Failed to post live stats")
    end
  else
    warn("[Overclock] tick " .. iteration .. ": collectPlayers error")
  end

  -- 2) persistent bans - every tick (re-ban banned players on fresh join)
  local ok, banned = pcall(fetchBannedNames)
  if ok and banned then
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
  else
    warn("[Overclock] tick " .. iteration .. ": fetchBannedNames error")
  end

  -- 3) announcements - every 10th tick (~30s pickup, enough for announcements)
  if iteration % 10 == 1 then
    local ok2, ann = pcall(fetchLatestAnnouncement)
    if ok2 and ann and ann.id and ann.id > lastAnnouncementId then
      log("New announcement id=" .. ann.id .. " (last=" .. lastAnnouncementId .. "), announcing")
      fire(":announce " .. ann.text)
      lastAnnouncementId = ann.id
    elseif not ok2 then
      warn("[Overclock] tick " .. iteration .. ": fetchLatestAnnouncement error")
    end
  end

  -- 4) command queue - every 3rd tick (~9s pickup, flashbang etc.)
  if iteration % 3 == 1 then
    local ok2b, cmd = pcall(fetchLatestCommand)
    if ok2b and cmd and cmd.id and cmd.id > lastCommandId then
      log("New command id=" .. cmd.id .. " (last=" .. lastCommandId .. "), firing")
      fireSequence(cmd.command)
      lastCommandId = cmd.id
    elseif not ok2b then
      warn("[Overclock] tick " .. iteration .. ": fetchLatestCommand error")
    end
  end

  task.wait(POLL_INTERVAL)
end
