-- Overclock - persistent in-game bans + announcements
-- Polls Supabase for the ban list and announcements, enforces in-game.
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

local function fetchBannedNames()
  local data = get(SUPABASE_URL .. "/rest/v1/ingame_bans?select=name")
  local names = {}
  if data then
    for _, row in ipairs(data) do names[row.name:lower()] = true end
  end
  return names
end

local function fetchLatestAnnouncement()
  local data = get(SUPABASE_URL .. "/rest/v1/ingame_announcements?select=id,text&order=id.desc&limit=1")
  return data and data[1] or nil
end

local alreadyFired = {}
local lastAnnouncementId = 0

while true do
  local ok, banned = pcall(fetchBannedNames)
  if ok and banned then
    for _, player in ipairs(Players:GetPlayers()) do
      local name = player.Name:lower()
      if banned[name] and not alreadyFired[name] then
        pcall(function()
          getRemote():FireServer(commandbarnum, ":ban " .. player.Name)
        end)
        alreadyFired[name] = true
        print("[Overclock] Auto-banned " .. player.Name)
      end
    end
  end

  local ok2, ann = pcall(fetchLatestAnnouncement)
  if ok2 and ann and ann.id and ann.id > lastAnnouncementId then
    pcall(function()
      getRemote():FireServer(commandbarnum, ":announce " .. ann.text)
    end)
    lastAnnouncementId = ann.id
    print("[Overclock] Announced: " .. ann.text)
  end

  task.wait(POLL_INTERVAL)
end
