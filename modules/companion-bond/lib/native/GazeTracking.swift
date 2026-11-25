import Foundation
import CoreGraphics

// 只使用当前帧的窗口局部坐标；不记录鼠标轨迹，不安装全局事件监听。
struct GazeTracking {
    var x=0.0, y=0.0
    var headX=0.0,headY=0.0
    var lastTime: TimeInterval?
    var near=false
    mutating func update(pointer:CGPoint, bounds:CGRect, now:TimeInterval, eyeCenter:CGPoint=CGPoint(x:0.473,y:0.574), fullHeight:Bool=false) {
        guard bounds.height > 0 else { reset(); return }
        let h=bounds.height
        let body=CGRect(x:bounds.midX-h*0.25,y:bounds.minY+h*(fullHeight ? 0.01:0.15),width:h*0.5,height:h*(fullHeight ? 0.98:0.70))
        let dx=max(body.minX-pointer.x,0,pointer.x-body.maxX)
        let dy=max(body.minY-pointer.y,0,pointer.y-body.maxY)
        let distance=hypot(dx,dy),radius=min(240,max(100,h*0.65))
        let u=min(1,max(0,(distance-radius*0.65)/(radius*0.35)))
        let weight=1-u*u*(3-2*u)
        near=weight>0.05
        let eyes=CGPoint(x:bounds.midX+(eyeCenter.x-0.5)*h*0.5,y:bounds.minY+h*eyeCenter.y)
        let targetX=max(-1,min(1,(pointer.x-eyes.x)/(h*0.36)))*weight
        let targetY=max(-1,min(1,(pointer.y-eyes.y)/(h*0.36)))*weight
        let dt=min(0.10,max(0,now-(lastTime ?? now-1.0/30.0)))
        lastTime=now
        let amount=1-exp(-dt/(near ? 0.11 : 0.20))
        x += (targetX-x)*amount; y += (targetY-y)*amount
        let headAmount=1-exp(-dt/(near ? 0.20 : 0.28))
        headX += (targetX-headX)*headAmount;headY += (targetY-headY)*headAmount
        if abs(headX)<0.001 { headX=0 };if abs(headY)<0.001 { headY=0 }
        if abs(x)<0.001 { x=0 }; if abs(y)<0.001 { y=0 }
    }
    mutating func reset() { x=0;y=0;headX=0;headY=0;lastTime=nil;near=false }
    var direction:String {
        let horizontal=x < -0.15 ? "左" : x > 0.15 ? "右" : ""
        let vertical=y < -0.15 ? "下" : y > 0.15 ? "上" : ""
        return horizontal+vertical
    }
}
