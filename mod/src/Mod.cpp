// BedmcpHot: makes bedmcp's resource-pack test cycle (leave the world, rejoin) faster.
//
// A leave + rejoin runs two full resource reloads: on the leave the game loads the title screen's
// global packs (~5 s nobody looks at), on the join the world's packs (re-reading the files, which
// is what shows the change). "skipleave" skips the first one: the cycle goes from ~12 s to ~8 s
// (measured 2026-11-18: 8 of 8 skipped rejoins worked and the new texture showed).
//
// In-place reloads inside the world were tried and dropped: _beginReloadingResources and
// _onActiveResourcePacksChanged crash the game there; handleReloadUIDefinitions re-reads the JSON
// UI but leaves the HUD with raw text and missing textures and forms undrawn; the
// onActiveResourcePacksChanged listener and onRequestResourceReload do nothing.
//
// Protocol (files in the mod folder, so no port or token is needed):
//   bedmcp writes trigger.json  {"id": <increasing number>, "action": "<action>"}
//   the mod answers status.json {"id": ..., "action": ..., "ok": bool, "ms": ..., "skipped": <count>,
//                               "armed": bool, "at": <unix ms>}
// Actions (taken on the client thread, from the ClientInstance::update hook):
//   skipleave  skip the next resource reload (send right before leaving a world)
//   unskip     disarm it (send once the title screen shows, in case the leave reloaded nothing)
//   ping       nothing: answers, to check the mod runs
// A watcher thread polls trigger.json every 100 ms; the game thread is never blocked by it.
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "ll/api/memory/Hook.h"
#include "ll/api/mod/NativeMod.h"
#include "ll/api/mod/RegisterHelper.h"
#include "ll/api/service/TargetedBedrock.h"

#include "mc/client/game/ClientInstance.h"
#include "mc/client/game/IMinecraftGame.h"
#include "mc/client/game/MinecraftGame.h"

namespace bedmcp_hot {

using json  = nlohmann::json;
using Clock = std::chrono::steady_clock;

namespace {

std::filesystem::path gDir;
std::mutex            gMutex;
long long             gPendingId = 0; // a request waiting for the client thread (0: none)
std::string           gPendingAction;
long long             gLastId = 0; // the last id taken from trigger.json
std::atomic_bool      gStop{false};
// "skipleave": the next resource reload (the one the game runs when it leaves a world, to load the
// title screen's global packs) is skipped; the join's reload of the world's packs reads the files.
std::atomic_bool      gSkipNextReload{false};
std::atomic_int       gSkipped{0};
std::thread           gWatcher;

void writeStatus(json const& j) {
    auto tmp = gDir / "status.json.tmp";
    {
        std::ofstream out(tmp, std::ios::trunc);
        out << j.dump();
    }
    std::error_code ec;
    std::filesystem::rename(tmp, gDir / "status.json", ec);
}

void watch() {
    auto                            file = gDir / "trigger.json";
    std::filesystem::file_time_type seen{};
    while (!gStop) {
        std::error_code ec;
        auto            t = std::filesystem::last_write_time(file, ec);
        if (!ec && t != seen) {
            seen = t;
            std::ifstream in(file);
            auto          j = json::parse(in, nullptr, false);
            if (!j.is_discarded() && j.contains("id") && j["id"].is_number_integer()) {
                long long id = j["id"].get<long long>();
                std::lock_guard lock(gMutex);
                if (id > gLastId) {
                    gLastId        = id;
                    gPendingId     = id;
                    gPendingAction = j.value("action", "ui");
                }
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

void run(ClientInstance& ci, long long id, std::string const& action) {
    json r{{"id", id}, {"action", action}, {"ok", true}};
    auto t0 = Clock::now();
    (void)ci;
    try {
        if (action == "skipleave") gSkipNextReload = true;
        else if (action == "unskip") gSkipNextReload = false;
        else if (action != "ping") r = json{{"id", id}, {"action", action}, {"ok", false}, {"error", "unknown action"}};
    } catch (std::exception const& e) {
        r["ok"]    = false;
        r["error"] = e.what();
    } catch (...) {
        r["ok"]    = false;
        r["error"] = "exception";
    }
    r["skipped"] = gSkipped.load();
    r["armed"]   = gSkipNextReload.load();
    r["ms"] = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    r["at"] = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    writeStatus(r);
}

} // namespace

LL_TYPE_INSTANCE_HOOK(HotUpdateHook, ll::memory::HookPriority::Normal, ClientInstance, &ClientInstance::$update, bool, bool isInitFinished, bool allowGameUpdate) {
    bool r = origin(isInitFinished, allowGameUpdate);
    if (isInitFinished) {
        long long   id = 0;
        std::string action;
        {
            std::lock_guard lock(gMutex);
            if (gPendingId) {
                id             = gPendingId;
                action         = gPendingAction;
                gPendingId     = 0;
            }
        }
        if (id) run(*this, id, action);
    }
    return r;
}

LL_TYPE_INSTANCE_HOOK(
    HotSkipReloadHook,
    ll::memory::HookPriority::Normal,
    MinecraftGame,
    &MinecraftGame::_onActiveResourcePacksChanged,
    void,
    ::ResourcePackManager& mgr,
    bool                   fullVanillaPackOnStack
) {
    if (gSkipNextReload.exchange(false)) {
        ++gSkipped;
        writeStatus(json{{"id", -1}, {"action", "skipped-reload"}, {"ok", true}, {"skipped", gSkipped.load()}});
        return;
    }
    origin(mgr, fullVanillaPackOnStack);
}

class Mod {
public:
    static Mod& getInstance() {
        static Mod instance;
        return instance;
    }
    Mod() : mSelf(*ll::mod::NativeMod::current()) {}
    [[nodiscard]] ll::mod::NativeMod& getSelf() const { return mSelf; }

    bool load() { return true; }

    bool enable() {
        gDir = getSelf().getModDir();
        // A trigger left over from an earlier run must not fire now.
        std::error_code ec;
        std::filesystem::remove(gDir / "trigger.json", ec);
        writeStatus(json{{"id", 0}, {"action", "start"}, {"ok", true}});
        gStop = false;
        gWatcher = std::thread(watch);
        HotUpdateHook::hook();
        HotSkipReloadHook::hook();
        getSelf().getLogger().info("BedmcpHot ready: write trigger.json in {}", gDir.string());
        return true;
    }

    bool disable() {
        HotSkipReloadHook::unhook();
        HotUpdateHook::unhook();
        gStop = true;
        if (gWatcher.joinable()) gWatcher.join();
        return true;
    }

private:
    ll::mod::NativeMod& mSelf;
};

} // namespace bedmcp_hot

LL_REGISTER_MOD(bedmcp_hot::Mod, bedmcp_hot::Mod::getInstance());
