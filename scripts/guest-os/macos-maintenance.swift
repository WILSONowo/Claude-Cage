import AppKit
import IOKit
import Security
import CryptoKit

// Only the pinned, root-owned package staged by the provisioning script may
// be opened. Installation and authorization remain Apple's responsibility.
@MainActor
enum MacFUSESetup {
    static let package = URL(fileURLWithPath: "/Library/Application Support/Cage/Installers/macFUSE.pkg")
    static let bundledApplication = URL(fileURLWithPath: "/Library/Filesystems/macfuse.fs/Contents/Resources/macfuse.app")
    static var installerAvailable: Bool { FileManager.default.fileExists(atPath: package.path) }
    static func supportsVersion(_ version: String) -> Bool {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard (2...3).contains(parts.count),
              parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
              let major = Int(parts[0]), let minor = Int(parts[1]) else { return false }
        return major > 5 || (major == 5 && minor >= 5)
    }
    static var installed: Bool {
        let driver = URL(fileURLWithPath: "/Library/Filesystems/macfuse.fs")
        guard let version = Bundle(url: driver)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              supportsVersion(version) else { return false }
        var code: SecStaticCode?, requirement: SecRequirement?
        let identity = "anchor apple generic and identifier \"io.macfuse.app\" and certificate leaf[subject.OU] = \"3T5GSNBU6W\""
        return SecStaticCodeCreateWithPath(bundledApplication as CFURL, [], &code) == errSecSuccess &&
            SecRequirementCreateWithString(identity as CFString, [], &requirement) == errSecSuccess &&
            code != nil && requirement != nil && SecStaticCodeCheckValidity(code!, [], requirement!) == errSecSuccess
    }
    static var application: URL {
        let alias = URL(fileURLWithPath: "/Applications/macFUSE.app")
        return FileManager.default.fileExists(atPath: alias.path) ? alias : bundledApplication
    }
    static func openInstaller() async throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: package.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              attributes[.ownerAccountID] as? Int == 0,
              let mode = attributes[.posixPermissions] as? Int, mode & 0o022 == 0 else {
            throw Failure(7, "macfuse_installer_untrusted")
        }
        let data = try Data(contentsOf: package, options: .mappedIfSafe)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == "5acf9e30bab227707de8d15eb28472a0cc9ed45709846b3e067d283294dc7f9e" else {
            throw Failure(7, "macfuse_installer_untrusted")
        }
        let installer = URL(fileURLWithPath: "/System/Library/CoreServices/Installer.app")
        _ = try await NSWorkspace.shared.open([package], withApplicationAt: installer,
                                             configuration: NSWorkspace.OpenConfiguration())
    }
}

// Invoked directly by the installation identity after verifying this bundle.
// Only Apple system settings and its authorization UI can supply a target.
@MainActor
enum MacMaintenance {
    private static let applications: Set<String> = ["com.apple.systempreferences", "com.apple.authorizationhost"]
    private static let panes = [
        "projects": "x-apple.systempreferences:com.apple.ExtensionsPreferences?extensionPointIdentifier=com.apple.fskit.fsmodule",
        "screen": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "input": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    ]

    static func settingsURL(for purpose: String) -> URL? {
        panes[purpose].flatMap { URL(string: $0) }
    }

    static func runPasswordProbe(purpose: String) -> Never {
        guard panes[purpose] != nil else { exit(2) }
        MacSetupPassword.runStream()
    }

    private static func consoleSession() throws -> String {
        try consoleUser()
        let entry = IORegistryGetRootEntry(kIOMainPortDefault)
        guard entry != 0 else { throw Failure(4, "requires_gui_login") }
        defer { IOObjectRelease(entry) }
        guard let property = IORegistryEntryCreateCFProperty(entry, "IOConsoleUsers" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
              let sessions = property as? [[String: Any]] else { throw Failure(4, "requires_gui_login") }
        let active = sessions.filter { $0["kCGSSessionOnConsoleKey"] as? Bool == true }
        guard active.count == 1, let current = active.first,
              current["kCGSessionLoginDoneKey"] as? Bool == true,
              current["CGSSessionScreenIsLocked"] as? Bool != true,
              current["kCGSSessionUserIDKey"] as? UInt32 == getuid(),
              current["kCGSSessionUserNameKey"] as? String == NSUserName(),
              let session = current["CGSSessionUniqueSessionUUID"] as? String,
              UUID(uuidString: session) != nil else { throw Failure(4, "requires_gui_login") }
        return session
    }

    private static func verified(_ app: NSRunningApplication) -> Bool {
        guard let bundle = app.bundleIdentifier, applications.contains(bundle) else { return false }
        var code: SecCode?, requirement: SecRequirement?
        return SecRequirementCreateWithString("anchor apple and identifier \"\(bundle)\"" as CFString, [], &requirement) == errSecSuccess &&
            SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: app.processIdentifier] as CFDictionary, [], &code) == errSecSuccess &&
            code != nil && requirement != nil && SecCodeCheckValidity(code!, [], requirement!) == errSecSuccess
    }

    static func run(_ operation: String, purpose: String) throws -> [String: Any] {
        try requireGuest()
        let session = try consoleSession()
        guard let url = settingsURL(for: purpose) else { throw Failure(8, "maintenance_purpose_invalid") }
        if operation == "open" {
            if purpose == "projects" {
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = false
                NSWorkspace.shared.openApplication(at: MacFUSESetup.application, configuration: configuration)
            }
            guard NSWorkspace.shared.open(url) else { throw Failure(8, "maintenance_open_failed") }
            return ["opened": true]
        }
        guard operation == "probe", let front = NSWorkspace.shared.frontmostApplication else {
            throw Failure(7, "maintenance_foreground_changed")
        }
        if !verified(front) {
            return ["error": "maintenance_foreground_changed", "blocking_pid": front.processIdentifier,
                    "blocking_bundle": front.bundleIdentifier ?? ""]
        }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw Failure(7, "maintenance_window_unavailable")
        }
        let display = CGDisplayBounds(CGMainDisplayID())
        var covering: [(bounds: CGRect, pid: Int32?, window: UInt32?)] = []
        for window in windows {
            guard let raw = window[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary), bounds.width > 0, bounds.height > 0,
                  (window[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
            let owner = window[kCGWindowOwnerPID as String] as? Int32
            if owner == front.processIdentifier && bounds.width >= 100 && bounds.height >= 60 {
                let region = bounds.intersection(display)
                guard !region.isNull, region.width >= 80, region.height >= 40,
                      let id = window[kCGWindowNumber as String] as? UInt32 else {
                    throw Failure(7, "maintenance_window_unavailable")
                }
                guard try consoleSession() == session else { throw Failure(4, "requires_gui_login") }
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == front.processIdentifier else {
                    throw Failure(7, "maintenance_foreground_changed")
                }
                if let blocker = covering.first(where: { $0.bounds.intersects(region) }) {
                    let bundle = blocker.pid.flatMap { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier }
                    return ["error": "maintenance_window_obscured", "blocking_pid": blocker.pid ?? 0,
                            "blocking_window": blocker.window ?? 0, "blocking_bundle": bundle ?? ""]
                }
                return ["version": 1, "session": session, "user": NSUserName(), "pid": front.processIdentifier,
                    "window": id, "bundle": front.bundleIdentifier!,
                    "password_focused": MacSetupPassword.passwordFocused(front, window: bounds),
                    "rect": [region.minX, region.minY, region.width, region.height],
                    "display": [display.minX, display.minY, display.width, display.height]]
            }
            if owner != front.processIdentifier {
                covering.append((bounds, owner, window[kCGWindowNumber as String] as? UInt32))
            }
        }
        throw Failure(7, "maintenance_window_unavailable")
    }
}
