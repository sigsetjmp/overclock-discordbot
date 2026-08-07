-- Overclock - in-game enforcement + live stats board
-- Polls Supabase for bans/announcements, posts live player stats,
-- manages the Server MVP cape (one cape always on the current MVP).
-- Config:
local SUPABASE_URL = "https://YOURPROJECT.supabase.co" -- Project Settings > API
local SUPABASE_ANON_KEY = "eyJ..." -- public anon key
local POLL_INTERVAL = 5 -- seconds

-- The command bar number changes every server update.
-- Get it manually, then update commandbarnum here and re-execute.
local commandbarnum = "11111111111KCmdBar"

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
    end
  end
  return list, mvp
end

local function fire(cmd)
  pcall(function()
    getRemote():FireServer(commandbarnum, cmd)
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
      if currentMvp and currentMvp ~= mvp then
        fire(":uncape " .. currentMvp)
        print("[Overclock] Uncaped " .. currentMvp)
      end
      if currentMvp ~= mvp then
        fire(":cape " .. mvp)
        currentMvp = mvp
        print("[Overclock] Capped " .. mvp)
      end
      fire(":n TYPE IN CHAT FOR GUN/MAP CHANGE. Current Server MVP: " .. mvp)
    else
      currentMvp = nil
    end

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
