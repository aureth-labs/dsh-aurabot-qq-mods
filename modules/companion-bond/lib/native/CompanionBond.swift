import AppKit
import Darwin

final class CharacterView: NSImageView {
    var idleRenderer = IdleMotion()
    var gaze = GazeTracking()
    var idleEnabled = false
    var idleStage="low"
    var idleStageName = "低级 · Q 版"
    var idleTimer: Timer?
    var lastIdleLabel = ""
    func configureIdle(path:String,closedPath:String,enabled:Bool,stageName:String,stage:String) {
        if idleEnabled != enabled || idleStage != stage { lastIdleLabel=""; gaze.reset() }
        idleEnabled=enabled;idleStageName=stageName;idleStage=stage
        if enabled { idleRenderer.configure(path:path,closedPath:closedPath,stage:stage) }
        if idleTimer == nil {
            let timer=Timer(timeInterval:1.0/30.0,repeats:true) { [weak self] _ in
                guard let self=self,self.idleEnabled,self.window?.isVisible == true else { return }
                self.needsDisplay=true
            }
            RunLoop.main.add(timer,forMode:.common)
            idleTimer=timer
        }
        needsDisplay=true
    }
    func drawIdle() {
        if idleEnabled,let window=window {
            let point=convert(window.convertPoint(fromScreen:NSEvent.mouseLocation),from:nil)
            let padding=idleRenderer.middle>0.5 ? bounds.height*12/(idleRenderer.size.height+24):0
            gaze.update(pointer:point,bounds:bounds.insetBy(dx:0,dy:padding),now:ProcessInfo.processInfo.systemUptime,eyeCenter:idleRenderer.eyeCenter,fullHeight:idleRenderer.middle>0.5)
            idleRenderer.gazeX=gaze.x;idleRenderer.gazeY=gaze.y
            idleRenderer.headX=gaze.headX;idleRenderer.headY=gaze.headY
        }
        guard idleEnabled,let (cg,extent)=idleRenderer.frame(now:ProcessInfo.processInfo.systemUptime),idleRenderer.size.height > 0 else { super.draw(bounds);return }
        let padding=idleRenderer.middle>0.5 ? bounds.height*12/(idleRenderer.size.height+24):0
        let scale=(bounds.height-padding*2)/idleRenderer.size.height
        let rect=NSRect(x:bounds.midX-idleRenderer.size.width*scale/2+extent.minX*scale,y:padding+extent.minY*scale,width:extent.width*scale,height:extent.height*scale)
        NSImage(cgImage:cg,size:extent.size).draw(in:rect,from:.zero,operation:.sourceOver,fraction:1,respectFlipped:true,hints:nil)
        let eyes = gaze.near && !gaze.direction.isEmpty ? "偏头看鼠标（"+gaze.direction+"）" : "尾巴轻摆、呆毛晃晃"
        let label=idleStageName+" · 待机："+(idleRenderer.blinkAmount > 0.65 ? "眨眼" : eyes)
        if label != lastIdleLabel { lastIdleLabel=label;setAccessibilityValue(label) }
    }
    override func draw(_ dirtyRect:NSRect) {
        NSGraphicsContext.current?.cgContext.clear(bounds)
        drawIdle()
    }
    override var acceptsFirstResponder: Bool { false }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func rightMouseDown(with event: NSEvent) {
        guard let menu = menu else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}

final class Companion: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    var imageView = CharacterView()
    var timer: Timer?
    var bridge: URL
    var request: URL
    var location: URL
    var session = ""
    var imagePath = ""
    var height: CGFloat = 0
    var locallyHidden = false
    var model: [String: Any] = [:]
    var lastSavedFrame: NSRect = .zero
    var expectedParent:pid_t=0
    var expectedSession=""
    init(path: String) {
        bridge = URL(fileURLWithPath: path)
        if let raw=try? Data(contentsOf:bridge),let data=(try? JSONSerialization.jsonObject(with:raw)) as? [String:Any],let pid=data["parentPid"] as? Int { expectedParent=pid_t(pid);expectedSession=data["session"] as? String ?? "" }
        request = bridge.deletingLastPathComponent().appendingPathComponent("desktop-request.json")
        location = bridge.deletingLastPathComponent().appendingPathComponent("desktop-position.json")
        super.init()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        panel = NSPanel(contentRect: NSRect(x: 0,y: 0,width: 220,height: 300),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "相伴养成 · 桌面立绘"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.isExcludedFromWindowsMenu = true
        panel.contentView = imageView
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.toolTip = "相伴养成：拖动可移动，右键可隐藏或预览外观"
        imageView.setAccessibilityLabel("相伴养成桌面立绘")
        imageView.setAccessibilityRole(.image)
        update()
        timer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in self?.update() }
    }
    func send(_ action: String, stage: String? = nil, enabled: Bool? = nil) {
        var data: [String:Any] = ["session": session, "action": action]
        if let stage = stage { data["stage"] = stage }
        if let enabled=enabled { data["enabled"] = enabled }
        if let raw = try? JSONSerialization.data(withJSONObject: data) { try? raw.write(to: request, options: .atomic) }
    }
    @objc func hideCharacter() { locallyHidden = true; send("hide"); panel.orderOut(nil) }
    @objc func toggleIdle() { send("idle",enabled:!(model["idleEnabled"] as? Bool ?? true)) }
    @objc func chooseStage(_ sender: NSMenuItem) { send("preview", stage: sender.representedObject as? String) }
    func menuFor(_ data: [String:Any]) -> NSMenu {
        let menu = NSMenu()
        let stage = data["stageName"] as? String ?? ""
        let bond = data["bond"] as? Int ?? 0
        let title = NSMenuItem(title: "\(stage)  ·  亲密度 \(bond)", action: nil, keyEquivalent: "")
        title.isEnabled = false; menu.addItem(title)
        menu.addItem(.separator())
        for (value,name) in [("auto","按亲密度自动切换"),("low","预览低级 · Q 版"),("middle","预览中级 · 精细版"),("high","预览高级 · 简约版")] {
            let item = NSMenuItem(title:name, action:#selector(chooseStage(_:)), keyEquivalent:"")
            item.target = self; item.representedObject = value
            let preview = data["preview"] as? Bool ?? false
            item.state = ((!preview && value == "auto") || (preview && value == (data["stage"] as? String))) ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let idle=NSMenuItem(title:(data["idleEnabled"] as? Bool ?? true) ? "暂停待机动画" : "开启待机动画",action:#selector(toggleIdle),keyEquivalent:"")
        idle.target=self;menu.addItem(idle)
        menu.addItem(.separator())
        let hide = NSMenuItem(title:"隐藏立绘", action:#selector(hideCharacter), keyEquivalent:"")
        hide.target = self; menu.addItem(hide)
        return menu
    }
    func savePosition() {
        guard panel.frame != lastSavedFrame else { return }
        lastSavedFrame = panel.frame
        let point = ["x": panel.frame.minX, "y": panel.frame.minY]
        if let raw = try? JSONSerialization.data(withJSONObject: point) { try? raw.write(to: location, options: .atomic) }
    }
    func update() {
        // 宿主退出、停止更新或停用模块时收起，不遗留悬浮窗。
        guard expectedParent>1, kill(expectedParent,0) == 0,
              let raw = try? Data(contentsOf: bridge),
              let data = (try? JSONSerialization.jsonObject(with: raw)) as? [String:Any],
              data["enabled"] as? Bool == true, data["parentPid"] as? Int == Int(expectedParent), data["session"] as? String == expectedSession,
              let updatedAt = data["updatedAt"] as? Double,
              Date().timeIntervalSince1970 * 1000 - updatedAt < 20000 else { NSApp.terminate(nil); return }
        model = data
        session = data["session"] as? String ?? ""
        let path = data["assetPath"] as? String ?? ""
        let wantedHeight = CGFloat(data["height"] as? Double ?? 300)
        if imagePath != path || height != wantedHeight {
            guard let image = NSImage(contentsOfFile: path) else { NSApp.terminate(nil); return }
            let screen = panel.screen ?? NSScreen.main!
            let visible = screen.visibleFrame
            let h = min(max(140,wantedHeight),visible.height-40)
            let w = h*0.62
            var frame = NSRect(x:visible.maxX-w-30,y:visible.minY+18,width:w,height:h)
            if height > 0 || imagePath == path { frame.origin = NSPoint(x:panel.frame.midX-w/2,y:panel.frame.minY) }
            else if let raw = try? Data(contentsOf: location),
                    let p = (try? JSONSerialization.jsonObject(with: raw)) as? [String:Double],
                    let x = p["x"], let y = p["y"] { frame.origin = NSPoint(x:x,y:y) }
            frame.origin.x = min(max(frame.origin.x,visible.minX),visible.maxX-w)
            frame.origin.y = min(max(frame.origin.y,visible.minY),visible.maxY-h)
            panel.setFrame(frame,display:true)
            imageView.image = image
            imagePath = path; height = wantedHeight
        }
        imageView.configureIdle(path:path,closedPath:data["idleBlinkPath"] as? String ?? "",enabled:(data["idleEnabled"] as? Bool ?? true) && ["low","middle","high"].contains(data["stage"] as? String ?? ""),stageName:data["stageName"] as? String ?? "",stage:data["stage"] as? String ?? "low")
        imageView.menu = menuFor(data)
        if !imageView.idleEnabled { imageView.setAccessibilityValue(data["stageName"] as? String ?? "") }
        if !locallyHidden { panel.orderFrontRegardless() }
        savePosition()
    }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); savePosition() }
}

@main
enum DesktopApp {
    static func main() {
guard CommandLine.arguments.count == 2 else { exit(2) }
let app = NSApplication.shared
let companion = Companion(path: CommandLine.arguments[1])
app.delegate = companion
app.run()
    }
}
