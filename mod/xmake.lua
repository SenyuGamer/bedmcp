add_rules("mode.debug", "mode.release")

add_repositories("levimc-repo https://github.com/LiteLDev/xmake-repo.git")

set_policy("package.requires_lock", true)

-- BedmcpHot: a client mod for bedmcp's test loop. It reloads the game's resources (JSON UI,
-- textures, lang, geometry) while staying in the world, on request from bedmcp.
add_requires("levilamina 26.60.7", {configs = {target_type = "client"}})
add_requires("levibuildscript")
add_requires("nlohmann_json v3.12.0")

if not has_config("vs_runtime") then
    set_runtimes("MD")
end

target("BedmcpHot")
    add_rules("@levibuildscript/linkrule")
    -- Packed here instead of @levibuildscript/modpacker (which needs a git tag for the version).
    after_build(function (target)
        local out = path.join(os.projectdir(), "bin", "BedmcpHot")
        os.mkdir(out)
        os.cp(target:targetfile(), out)
        io.writefile(path.join(out, "manifest.json"), [[{
    "name": "BedmcpHot",
    "entry": "BedmcpHot.dll",
    "version": "0.1.0",
    "type": "native",
    "platform": "client"
}
]])
    end)
    set_kind("shared")
    set_languages("c++20")
    set_toolchains("clang-cl")
    set_symbols("debug")
    -- Store only the .pdb file name in the DLL, not the build machine's folder.
    add_shflags("/PDBALTPATH:%_PDB%", {force = true})
    set_exceptions("none")
    add_defines("NOMINMAX", "UNICODE", "WIN32_LEAN_AND_MEAN", "_HAS_CXX23=1")
    add_cxflags("/utf-8", "/W4", "/EHa")
    add_cxflags("/EHs", {tools = {"clang_cl"}})
    add_cxflags(
        "-Wno-microsoft-cast",
        "-Wno-invalid-offsetof",
        "-Wno-c++2b-extensions",
        "-Wno-microsoft-include",
        "-Wno-overloaded-virtual",
        "-Wno-ignored-qualifiers",
        "-Wno-missing-field-initializers",
        "-Wno-potentially-evaluated-expression",
        "-Wno-pragma-system-header-outside-header",
        {tools = {"clang_cl"}}
    )
    add_packages("levilamina", "nlohmann_json")
    add_includedirs("src")
    add_files("src/**.cpp")
