import AppKit
import CoreImage

// 局部连续形变：脚与躯干稳定，尾巴、发梢、呆毛有不同的相位和幅度。
// 每帧只处理约 640 像素高的纹理，不生成新图片文件、不访问网络。
final class IdleMotion {
    let context = CIContext(options:[.cacheIntermediates:false])
    let warp = CIWarpKernel(source:"""
        kernel vec2 cuteIdle(float t, float w, float h, float middle,float high) {
            vec2 p=destCoord(); vec2 q=p/vec2(w,h);
            float originalTail=smoothstep(0.67,0.94,q.x)*(1.0-smoothstep(0.47,0.54,q.y))*smoothstep(0.20,0.30,q.y);
            float leftTail=(1.0-smoothstep(0.28,0.38,q.x))*smoothstep(0.065,0.12,q.y)*(1.0-smoothstep(0.34,0.39,q.y));
            float rightTail=smoothstep(0.68,0.86,q.x)*smoothstep(0.07,0.15,q.y)*(1.0-smoothstep(0.42,0.48,q.y));
            float tail=mix(originalTail,min(1.0,leftTail+rightTail),high);
            float tuft=smoothstep(mix(0.785,0.935,middle),mix(0.842,0.975,middle),q.y)*(1.0-smoothstep(mix(0.86,1.02,middle),mix(0.9,1.04,middle),q.y));
            float sides=smoothstep(0.17,0.40,abs(q.x-0.5));
            float hair=sides*smoothstep(mix(0.32,0.52,middle),mix(0.44,0.61,middle),q.y)*(1.0-smoothstep(mix(0.66,0.78,middle),mix(0.74,0.84,middle),q.y));
            float upper=smoothstep(mix(0.23,0.36,middle),mix(0.52,0.69,middle),q.y)*(1.0-smoothstep(mix(0.87,0.985,middle),mix(0.93,1.03,middle),q.y));
            float dx=tail*w*mix(0.045,0.032,high)*sin(t*mix(1.75,1.4,high)+q.y*7.0)+tuft*w*0.032*sin(t*2.1+q.y*8.0)+hair*w*0.018*sin(t*1.65+q.y*6.0);
            dx += upper*w*0.0025*sin(t*1.3);
            float dy=tail*h*0.006*sin(t*mix(1.75,1.4,high)+1.0)+tuft*h*0.0025*sin(t*2.1)+upper*h*0.0028*sin(t*1.65);
            return p-vec2(dx,dy);
        }
        """)
    let gazeWarp = CIWarpKernel(source:"""
        kernel vec2 followEyes(float w,float h,float gx,float gy,float middle,float high) {
            vec2 p=destCoord(); vec2 q=p/vec2(w,h);
            float left=length((q-mix(mix(vec2(0.372,0.574),vec2(0.400,0.822),middle),vec2(0.460,0.831),high))/mix(vec2(0.063,0.032),vec2(0.042,0.022),middle));
            float right=length((q-mix(mix(vec2(0.574,0.574),vec2(0.526,0.829),middle),vec2(0.572,0.839),high))/mix(vec2(0.063,0.032),vec2(0.042,0.022),middle));
            float m=1.0-smoothstep(0.52,1.0,min(left,right));
            // 小幅移动虹膜区域，眼角和外侧轮廓保持稳定。
            return p-vec2(gx*w*mix(0.018,0.0115,middle),gy*h*mix(0.0065,0.0030,middle))*m;
        }
        """)
    let headWarp = CIWarpKernel(source:"""
        kernel vec2 followHead(float w,float h,float gx,float gy,float middle,float high) {
            vec2 p=destCoord();vec2 q=p/vec2(w,h);
            float weight=smoothstep(mix(mix(0.492,0.757,middle),0.770,high),mix(mix(0.550,0.804,middle),0.817,high),q.y);
            if (weight<=0.0) return p;
            vec2 pivot=vec2(w*mix(mix(0.475,0.480,middle),0.520,high),h*mix(mix(0.503,0.766,middle),0.779,high));
            float a=gx*mix(0.095,0.080,middle)*weight;
            vec2 d=p-pivot-vec2(gx*w*0.010,gy*h*0.006)*weight;
            // 以脖子为支点的小幅侧倾：眼睛先动，头部稍晚跟上，脚底不转。
            return pivot+vec2(cos(a)*d.x-sin(a)*d.y,sin(a)*d.x+cos(a)*d.y);
        }
        """)
    var headX=0.0,headY=0.0
    var gazeX=0.0, gazeY=0.0
    let eyeMask = CIColorKernel(source:"""
        kernel vec4 blinkMask(float w,float h,float amount,float middle,float high) {
            vec2 q=destCoord()/vec2(w,h);
            float a=length((q-mix(mix(vec2(0.372,0.574),vec2(0.400,0.822),middle),vec2(0.460,0.831),high))/mix(vec2(0.09,0.043),vec2(0.056,0.028),middle));
            float b=length((q-mix(mix(vec2(0.574,0.574),vec2(0.526,0.829),middle),vec2(0.572,0.839),high))/mix(vec2(0.09,0.043),vec2(0.056,0.028),middle));
            float m=(1.0-smoothstep(0.72,1.0,min(a,b)))*amount;
            return vec4(m,m,m,1.0);
        }
        """)
    var middle=0.0,high=0.0
    var eyeCenter:CGPoint { high>0.5 ? CGPoint(x:0.516,y:0.835) : middle>0.5 ? CGPoint(x:0.463,y:0.8255) : CGPoint(x:0.473,y:0.574) }
    var source: CIImage?
    var closed: CIImage?
    var sourcePath="", blinkPath=""
    var started=ProcessInfo.processInfo.systemUptime
    var nextBlink=ProcessInfo.processInfo.systemUptime+3.2
    var blinkStart = -Double.infinity
    var blinkAmount=0.0
    var size = CGSize.zero
    func configure(path:String, closedPath:String, stage:String="low") {
        let nextMiddle=["middle","high"].contains(stage) ? 1.0 : 0.0
        let nextHigh=stage=="high" ? 1.0:0.0
        guard path != sourcePath || closedPath != blinkPath || middle != nextMiddle || high != nextHigh else { return }
        middle=nextMiddle;high=nextHigh
        sourcePath=path; blinkPath=closedPath
        guard let image=NSImage(contentsOfFile:path),let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil) else { source=nil; return }
        let scale=640.0/Double(cg.height)
        source=CIImage(cgImage:cg).transformed(by:CGAffineTransform(scaleX:scale,y:scale))
        size=source!.extent.size
        closed=nil
        if let c=NSImage(contentsOfFile:closedPath),let raw=c.cgImage(forProposedRect:nil,context:nil,hints:nil) {
            closed=CIImage(cgImage:raw).transformed(by:CGAffineTransform(scaleX:size.width/CGFloat(raw.width),y:size.height/CGFloat(raw.height)))
        }
    }
    func frame(now:TimeInterval) -> (CGImage,CGRect)? {
        guard var input=source,let warp=warp else { return nil }
        if now >= nextBlink {
            blinkStart=now; nextBlink=now+Double.random(in:3.2...6.2)
        }
        let phase=now-blinkStart
        if phase < 0.10 { blinkAmount=max(0,phase/0.10) }
        else if phase < 0.17 { blinkAmount=1 }
        else if phase < 0.31 { blinkAmount=max(0,1-(phase-0.17)/0.14) }
        else { blinkAmount=0 }
        if abs(gazeX)+abs(gazeY)>0.0001,let gazeWarp=gazeWarp,
           let followed=gazeWarp.apply(extent:input.extent,roiCallback:{ _,rect in rect.insetBy(dx:-12,dy:-12) },image:input,arguments:[size.width,size.height,gazeX,gazeY,middle,high]) {
            input=followed
        }
        if blinkAmount > 0,let closed=closed,
           let mask=eyeMask?.apply(extent:input.extent,arguments:[size.width,size.height,blinkAmount,middle,high]) {
            input=closed.applyingFilter("CIBlendWithMask",parameters:[kCIInputBackgroundImageKey:input,kCIInputMaskImageKey:mask])
        }
        if abs(headX)+abs(headY)>0.0001,let headWarp=headWarp,
           let turned=headWarp.apply(extent:input.extent,roiCallback:{ _,rect in rect.insetBy(dx:-40,dy:-32) },image:input,arguments:[size.width,size.height,headX,headY,middle,high]) {
            input=turned
        }
        let extent=input.extent.insetBy(dx:-24,dy:-12)
        guard let output=warp.apply(extent:extent,roiCallback:{ _,rect in rect.insetBy(dx:-48,dy:-32) },image:input,arguments:[now-started,size.width,size.height,middle,high]),
              let cg=context.createCGImage(output,from:extent) else { return nil }
        return (cg,extent)
    }
}
