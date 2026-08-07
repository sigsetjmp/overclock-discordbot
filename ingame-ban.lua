-- Overclock - in-game enforcement + live stats board
-- Polls Supabase for bans/announcements, posts live player stats,
-- manages the Server MVP cape (one cape always on the current MVP).
-- Config:
local SUPABASE_URL = "https://xtolxhpirwwzaumntmis.supabase.co" -- Project Settings > API
local SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0b2x4aHBpcnd3emF1bW50bWlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwOTA1NDEsImV4cCI6MjEwMTY2NjU0MX0.3tUydNTsM7pxU6ad8NRy6jsrQfWtNebw5SCO1ldWHZc" -- public anon key
local POLL_INTERVAL = 5 -- seconds between full syncs (bans/announcements/stats)
local COMMAND_DELAY = 0.5 -- seconds between dependent commands (:uncape before :cape)
local NOTIFY_INTERVAL = 60 -- seconds between :n notify messages (separate from the sync)

-- The command bar number changes every server update.
-- Get it manually, then update commandbarnum here and re-execute.
local commandbarnum = "12233232122KCmdBar"

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local function log(msg)
  print("[Overclock] " .. msg)
end

local function getRemote()
  return game:GetService("ReplicatedStorage")["b\007\010\007\010\007"]
end

local function get(url)
  local res = request({
    Url = url,
    Method = "GET",
    Headers = {
      ["apikey"] = SUPABASE_ANON_KEY,
      ["Authorization"] = "Bearer " .. SUPABASE_ANON_KEY,
      ["Content-Type"] = "application/json",
    },
  })
  if not res then
    warn("[Overclock] GET returned nil response: " .. url)
    return nil
  end
  if not res.Success then
    warn("[Overclock] GET failed (" .. tostring(res.StatusCode) .. "): " .. url)
    return nil
  end
  return HttpService:JSONDecode(res.Body)
end

local function post(url, body)
  local res = request({
    Url = url,
    Method = "POST",
    Headers = {
      ["apikey"] = SUPABASE_ANON_KEY,
      ["Authorization"] = "Bearer " .. SUPABASE_ANON_KEY,
      ["Content-Type"] = "application/json",
      ["Prefer"] = "resolution=merge-duplicates,return=minimal",
    },
    Body = HttpService:JSONEncode(body),
  })
  if not res or not res.Success then
    warn("[Overclock] POST failed (" .. tostring(res and res.StatusCode or "no response") .. "): " .. url)
    return false
  end
  return true
end

local function fetchBannedNames()
  local data = get(SUPABASE_URL .. "/rest/v1/ingame_bans?select=name")
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
  local data = get(SUPABASE_URL .. "/rest/v1/ingame_announcements?select=id,text&order=id.desc&limit=1")
  if not data or not data[1] then
    log("fetchLatestAnnouncement: none")
    return nil
  end
  log("fetchLatestAnnouncement: id=" .. data[1].id .. " text=\"" .. data[1].text .. "\"")
  return data[1]
end

local function fetchLatestCommand()
  local data = get(SUPABASE_URL .. "/rest/v1/ingame_commands?select=id,command&order=id.desc&limit=1")
  if not data or not data[1] then
    return nil
  end
  log("fetchLatestCommand: id=" .. data[1].id .. " command=\"" .. data[1].command .. "\"")
  return data[1]
end

local function fetchState()
  local data = get(SUPABASE_URL .. "/rest/v1/ingame_snapshot?select=data&id=eq.1")
  if not data or not data[1] or not data[1].data then
    log("fetchState: no snapshot row yet")
    return nil
  end
  local ok, parsed = pcall(function()
    return HttpService:JSONDecode(data[1].data)
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

local alreadyFired = {}
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

local iteration = 0
while true do
  iteration = iteration + 1
  log("--- tick " .. iteration .. " (" .. #Players:GetPlayers() .. " players online) ---")

  -- 1) persistent bans
  local ok, banned = pcall(fetchBannedNames)
  if ok and banned then
    for _, player in ipairs(Players:GetPlayers()) do
      local name = player.Name
      if banned[name] and not alreadyFired[name] then
        fire(":ban " .. player.Name)
        alreadyFired[name] = true
        log("Auto-banned " .. player.Name)
      end
    end
  else
    warn("[Overclock] tick " .. iteration .. ": fetchBannedNames error")
  end

  -- 2) announcements (once each)
  local ok2, ann = pcall(fetchLatestAnnouncement)
  if ok2 and ann and ann.id and ann.id > lastAnnouncementId then
    log("New announcement id=" .. ann.id .. " (last=" .. lastAnnouncementId .. "), announcing")
    fire(":announce " .. ann.text)
    lastAnnouncementId = ann.id
  elseif not ok2 then
    warn("[Overclock] tick " .. iteration .. ": fetchLatestAnnouncement error")
  end

  -- 2b) command queue (one-off commands like flashbang)
  local ok2b, cmd = pcall(fetchLatestCommand)
  if ok2b and cmd and cmd.id and cmd.id > lastCommandId then
    log("New command id=" .. cmd.id .. " (last=" .. lastCommandId .. "), firing")
    fireSequence(cmd.command)
    lastCommandId = cmd.id
  elseif not ok2b then
    warn("[Overclock] tick " .. iteration .. ": fetchLatestCommand error")
  end

  -- 3) live stats + MVP cape (all synced to the same tick)
  local ok3, players, mvp = pcall(function()
    return collectPlayers()
  end)
  if ok3 then
    if mvp then
      if currentMvp ~= mvp then
        if currentMvp then
          log("Removing cape from old MVP " .. currentMvp)
          fire(":uncape " .. currentMvp)
          task.wait(COMMAND_DELAY)
        end
        log("Giving cape to new MVP " .. mvp)
        fire(":cape " .. mvp)
        task.wait(COMMAND_DELAY)
        currentMvp = mvp
      end
    elseif currentMvp then
      log("No MVP anymore, removing cape from " .. currentMvp)
      fire(":uncape " .. currentMvp)
      task.wait(COMMAND_DELAY)
      currentMvp = nil
    end

    -- notify message runs on its own 60s timer
    if os.time() - lastNotify >= NOTIFY_INTERVAL then
      local text = "TYPE IN CHAT FOR GUN/MAP CHANGE. Current Server MVP: " .. (mvp or "none")
      fire(":n " .. text)
      lastNotify = os.time()
      log("Notified (mvp=" .. tostring(mvp) .. ")")
    end

    local ok4 = post(
      SUPABASE_URL .. "/rest/v1/ingame_snapshot?on_conflict=id",
      {
        { id = 1, data = HttpService:JSONEncode({ players = players, mvp = mvp, ts = os.time(), last_announced_id = lastAnnouncementId, last_command_id = lastCommandId }) },
      }
    )
    if ok4 then
      log("Snapshot posted: " .. #players .. " players, mvp=" .. tostring(mvp))
    else
      warn("[Overclock] Failed to post live stats")
    end
  else
    warn("[Overclock] tick " .. iteration .. ": collectPlayers error")
  end

  task.wait(POLL_INTERVAL)
end
