-- Overclock - persistent in-game bans
-- Polls Supabase for the ban list and auto-bans players in the server.
-- Config:
local SUPABASE_URL = "https://YOURPROJECT.supabase.co" -- Project Settings > API
local SUPABASE_ANON_KEY = "eyJ..." -- public anon key
local POLL_INTERVAL = 2 -- seconds

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local function getBanRemote()
  return game:GetService("ReplicatedStorage")["b\007\010\007\010\007"]
end

local function fetchBannedNames()
  local res = request({
    Url = SUPABASE_URL .. "/rest/v1/ingame_bans?select=name",
    Method = "GET",
    Headers = {
      ["apikey"] = SUPABASE_ANON_KEY,
      ["Authorization"] = "Bearer " .. SUPABASE_ANON_KEY,
      ["Content-Type"] = "application/json",
    },
  })
  if not res or not res.Success then return nil end
  local data = HttpService:JSONDecode(res.Body)
  local names = {}
  for _, row in ipairs(data) do
    names[row.name:lower()] = true
  end
  return names
end

local alreadyFired = {}

while true do
  local ok, banned = pcall(fetchBannedNames)
  if ok and banned then
    for _, player in ipairs(Players:GetPlayers()) do
      local name = player.Name:lower()
      if banned[name] and not alreadyFired[name] then
        pcall(function()
          getBanRemote():FireServer("11111111111KCmdBar", ":ban " .. player.Name)
        end)
        alreadyFired[name] = true
        print("[Overclock] Auto-banned " .. player.Name)
      end
    end
  end
  task.wait(POLL_INTERVAL)
end
