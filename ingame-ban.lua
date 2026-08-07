-- Overclock - in-game enforcement + live stats board
-- Polls Supabase for bans/announcements, posts live player stats,
-- manages the Server MVP cape (one cape always on the current MVP).
-- Config:
local SUPABASE_URL = "https://xtolxhpirwwzaumntmis.supabase.co" -- Project Settings > API
local SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0b2x4aHBpcnd3emF1bW50bWlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwOTA1NDEsImV4cCI6MjEwMTY2NjU0MX0.3tUydNTsM7pxU6ad8NRy6jsrQfWtNebw5SCO1ldWHZc" -- public anon key
local POLL_INTERVAL = 5 -- seconds
local CAPE_DELAY = 1.2 -- seconds between :uncape and :cape so the game registers both

-- The command bar number changes every server update.
-- Get it manually, then update commandbarnum here and re-execute.
local commandbarnum = "12233232122KCmdBar"

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

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
  if not res or not res.Success then return nil end
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
  return res and res.Success
end

local function fetchBannedNames()
  local data = get(SUPABASE_URL .. "/rest/v1/ingame_bans?select=name")
  local names = {}
  if data then
    for _, row in ipairs(data) do names[row.name] = true end
  end
  return names
end

local function fetchLatestAnnouncement()
  local data = get(SUPABASE_URL .. "/rest/v1/ingame_announcements?select=id,text&order=id.desc&limit=1")
  return data and data[1] or nil
end

local function readStat(player, name)
  local ls = player:FindFirstChild("leaderstats")
  if not ls then return 0 end
  local stat = ls:FindFirstChild(name)
  return stat and tonumber(stat.Value) or 0
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
    return list, nil
  end
  return list, mvp
end

local function fire(cmd)
  pcall(function()
    getRemote():FireServer(commandbarnum, cmd)
  end)
end

-- Cape changes run in a background task so commands get spacing
-- and the 5s loop is never delayed.
local capeBusy = false
local function scheduleCape(old, new)
  if capeBusy then return end
  capeBusy = true
  task.spawn(function()
    if old and old ~= new then
      fire(":uncape " .. old)
      print("[Overclock] Uncaped " .. old)
      task.wait(CAPE_DELAY)
    end
    fire(":cape " .. new)
    print("[Overclock] Capped " .. new)
    capeBusy = false
  end)
end

local function scheduleUncape(name)
  if capeBusy then return end
  capeBusy = true
  task.spawn(function()
    fire(":uncape " .. name)
    print("[Overclock] Uncaped " .. name)
    capeBusy = false
  end)
end

local alreadyFired = {}
local lastAnnouncementId = 0
local currentMvp = nil

while true do
  -- 1) persistent bans
  local ok, banned = pcall(fetchBannedNames)
  if ok and banned then
    for _, player in ipairs(Players:GetPlayers()) do
      local name = player.Name
      if banned[name] and not alreadyFired[name] then
        fire(":ban " .. player.Name)
        alreadyFired[name] = true
        print("[Overclock] Auto-banned " .. player.Name)
      end
    end
  end

  -- 2) announcements (once each)
  local ok2, ann = pcall(fetchLatestAnnouncement)
  if ok2 and ann and ann.id and ann.id > lastAnnouncementId then
    fire(":announce " .. ann.text)
    lastAnnouncementId = ann.id
    print("[Overclock] Announced: " .. ann.text)
  end

  -- 3) live stats + MVP cape
  local ok3, players, mvp = pcall(function()
    return collectPlayers()
  end)
  if ok3 then
    if mvp then
      if currentMvp ~= mvp then
        scheduleCape(currentMvp, mvp)
        currentMvp = mvp
      end
    elseif currentMvp then
      scheduleUncape(currentMvp)
      currentMvp = nil
    end

    -- notify message fires every poll so it always matches current stats
    fire(":n TYPE IN CHAT FOR GUN/MAP CHANGE. Current Server MVP: " .. (mvp or "none"))

    local ok4 = post(
      SUPABASE_URL .. "/rest/v1/ingame_snapshot?on_conflict=id",
      {
        { id = 1, data = HttpService:JSONEncode({ players = players, mvp = mvp, ts = os.time() }) },
      }
    )
    if not ok4 then
      warn("[Overclock] Failed to post live stats")
    end
  end

  task.wait(POLL_INTERVAL)
end
