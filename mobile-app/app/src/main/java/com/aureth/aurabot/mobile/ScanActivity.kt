package com.aureth.aurabot.mobile

import android.Manifest
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory

/**
 * 定制扫码页：圆角取景框、DeepSeek 蓝角标与柔光扫线、底部说明卡片与「改为粘贴」退路。
 * 拒绝相机权限时展示清晰的状态页与去设置/改粘贴入口，不留黑屏。
 */
class ScanActivity : AppCompatActivity() {
    private lateinit var root: FrameLayout
    private lateinit var barcodeView: BarcodeView
    private lateinit var finderOverlay: ScanFinderOverlay
    private lateinit var torchBtn: ImageView
    private lateinit var permissionContainer: ScrollView
    private var torchOn = false
    private var handledResult = false
    private var askedPermissionOnce = false

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            showScannerState()
            startCamera()
        } else {
            showPermissionState()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        buildUi()
        if (hasCameraPermission()) {
            showScannerState()
        } else {
            showPermissionState()
            askedPermissionOnce = true
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onResume() {
        super.onResume()
        if (hasCameraPermission() && !handledResult) {
            showScannerState()
            startCamera()
        } else if (!hasCameraPermission()) {
            showPermissionState()
        }
    }

    override fun onPause() {
        barcodeView.pause()
        super.onPause()
    }

    override fun finish() {
        super.finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun startCamera() {
        barcodeView.decodeSingle(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                if (handledResult) return
                val text = result.text?.trim().orEmpty()
                if (text.isEmpty()) return
                handledResult = true
                SilkUi.hapticConfirm(root)
                setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_QR_RESULT, text))
                finish()
            }

            override fun possibleResultPoints(resultPoints: MutableList<ResultPoint>?) {}
        })
        barcodeView.resume()
    }

    private fun showScannerState() {
        barcodeView.visibility = View.VISIBLE
        finderOverlay.visibility = View.VISIBLE
        permissionContainer.visibility = View.GONE
        torchBtn.visibility = View.VISIBLE
    }

    private fun showPermissionState() {
        barcodeView.pause()
        barcodeView.visibility = View.GONE
        finderOverlay.visibility = View.GONE
        torchBtn.visibility = View.GONE
        permissionContainer.visibility = View.VISIBLE
    }

    private fun buildUi() {
        val ctx = this
        root = FrameLayout(ctx).apply {
            setBackgroundColor(SilkUi.color(ctx, R.color.scan_surface))
        }

        barcodeView = BarcodeView(ctx).apply {
            decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
        }
        root.addView(barcodeView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        finderOverlay = ScanFinderOverlay(ctx)
        root.addView(finderOverlay, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        // 顶部栏：关闭按钮、标题、闪光灯
        val topBar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 16f), SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 12f))
        }
        val closeBtn = circleIconButton(R.drawable.ic_close, "关闭扫码") {
            setResult(Activity.RESULT_CANCELED)
            finish()
        }
        val title = TextView(ctx).apply {
            text = "扫码配对"
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            setTextColor(SilkUi.color(ctx, R.color.scan_fg))
            typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
        }
        torchBtn = circleIconButton(R.drawable.ic_flash, "手电筒") {
            torchOn = !torchOn
            barcodeView.setTorch(torchOn)
            updateTorchStyle()
        }
        topBar.addView(closeBtn)
        topBar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        topBar.addView(torchBtn)
        root.addView(topBar, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.TOP
        ))

        // 底部玻璃说明卡片与改用粘贴入口
        val bottomWrap = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 12f), SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 24f))
        }
        val tipCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 16f), SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 16f))
            background = SilkUi.darkGlassBackground(ctx, 22f)
        }
        tipCard.addView(TextView(ctx).apply {
            text = "在电脑上打开 Aurabot 面板的「手机端」，点「开启并生成二维码」，对准上方框内即可自动连接。"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(SilkUi.color(ctx, R.color.scan_fg))
            setLineSpacing(0f, 1.42f)
            gravity = Gravity.CENTER
        })
        bottomWrap.addView(tipCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        bottomWrap.addView(SilkUi.space(ctx, 14f))
        val manualBtn = TextView(ctx).apply {
            text = "改为粘贴二维码文字"
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(SilkUi.color(ctx, R.color.scan_fg))
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            minHeight = SilkUi.dp(ctx, 46f)
            setPadding(SilkUi.dp(ctx, 22f), SilkUi.dp(ctx, 11f), SilkUi.dp(ctx, 22f), SilkUi.dp(ctx, 11f))
            background = SilkUi.darkGlassBackground(ctx, 999f, isCircle = true)
            isClickable = true
            isFocusable = true
            SilkUi.attachPressScale(this)
            setOnClickListener {
                SilkUi.hapticClick(it)
                setResult(RESULT_MANUAL_PASTE)
                finish()
            }
        }
        bottomWrap.addView(manualBtn, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        root.addView(bottomWrap, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM
        ))

        // 无相机权限时的友好状态页
        permissionContainer = buildPermissionView()
        permissionContainer.visibility = View.GONE
        root.addView(permissionContainer, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        // 顶部栏提到最前，确保在无权限状态下也可点关闭
        topBar.bringToFront()

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            topBar.setPadding(SilkUi.dp(ctx, 20f), sys.top + SilkUi.dp(ctx, 12f), SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 12f))
            bottomWrap.setPadding(SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 12f), SilkUi.dp(ctx, 20f), sys.bottom + SilkUi.dp(ctx, 24f))
            insets
        }

        setContentView(root)
    }

    private fun buildPermissionView(): ScrollView {
        val ctx = this
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(SilkUi.dp(ctx, 28f), SilkUi.dp(ctx, 96f), SilkUi.dp(ctx, 28f), SilkUi.dp(ctx, 48f))
        }
        col.addView(TextView(ctx).apply {
            text = "需要相机权限"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            setTextColor(SilkUi.color(ctx, R.color.scan_fg))
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        })
        col.addView(SilkUi.space(ctx, 10f))
        col.addView(TextView(ctx).apply {
            text = "打开相机权限后才能扫描电脑上的二维码；也可以直接把二维码下面的文字粘贴进来。"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(SilkUi.color(ctx, R.color.scan_muted))
            setLineSpacing(0f, 1.45f)
            gravity = Gravity.CENTER
        })
        col.addView(SilkUi.space(ctx, 28f))
        val allowBtn = SilkUi.primaryButton(ctx, "允许相机权限") {
            if (!askedPermissionOnce || shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
                askedPermissionOnce = true
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            } else {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.fromParts("package", packageName, null))
                )
            }
        }
        col.addView(allowBtn, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        col.addView(SilkUi.space(ctx, 12f))
        val pasteBtn = TextView(ctx).apply {
            text = "改为粘贴二维码文字"
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(SilkUi.color(ctx, R.color.scan_fg))
            minHeight = SilkUi.dp(ctx, 52f)
            setPadding(SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 12f), SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 12f))
            background = SilkUi.darkGlassBackground(ctx, 999f, isCircle = true)
            isClickable = true
            isFocusable = true
            SilkUi.attachPressScale(this)
            setOnClickListener {
                setResult(RESULT_MANUAL_PASTE)
                finish()
            }
        }
        col.addView(pasteBtn, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        return ScrollView(ctx).apply {
            isFillViewport = true
            setBackgroundColor(SilkUi.color(ctx, R.color.scan_surface))
            addView(col)
        }
    }

    private fun circleIconButton(iconRes: Int, description: String, onClick: (View) -> Unit): ImageView {
        val ctx = this
        val size = SilkUi.dp(ctx, 46f)
        val pad = SilkUi.dp(ctx, 12f)
        return ImageView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(size, size)
            setPadding(pad, pad, pad, pad)
            setImageResource(iconRes)
            setColorFilter(SilkUi.color(ctx, R.color.scan_fg))
            contentDescription = description
            background = SilkUi.darkGlassBackground(ctx, 999f, isCircle = true)
            isClickable = true
            isFocusable = true
            SilkUi.attachPressScale(this, 0.88f)
            setOnClickListener { v ->
                SilkUi.hapticClick(v)
                onClick(v)
            }
        }
    }

    private fun updateTorchStyle() {
        val tint = SilkUi.color(this, if (torchOn) R.color.accent else R.color.scan_fg)
        torchBtn.setColorFilter(tint)
    }

    companion object {
        const val EXTRA_QR_RESULT = "qr_result"
        const val RESULT_MANUAL_PASTE = Activity.RESULT_FIRST_USER + 1
    }
}

/**
 * 扫码取景遮罩：中心留出圆角正方形视窗，DeepSeek 蓝四隅直角标，以及柔和的垂直扫描光束。
 */
private class ScanFinderOverlay(context: android.content.Context) : View(context) {
    private val maskPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = SilkUi.color(context, R.color.scan_overlay)
    }
    private val clearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = SilkUi.dpF(context, 1f)
        color = SilkUi.color(context, R.color.scan_pill)
    }
    private val cornerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = SilkUi.dpF(context, 3.5f)
        strokeCap = Paint.Cap.ROUND
        color = SilkUi.color(context, R.color.accent)
    }
    private val beamPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val beamLinePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val boxRect = RectF()
    private val beamRect = RectF()
    private var beamProgress = 0f
    private var lastW = 0f
    private var lastH = 0f
    private var animator: ValueAnimator? = null

    init {
        setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        animator?.cancel()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 2200L
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.RESTART
            interpolator = LinearInterpolator()
            addUpdateListener {
                beamProgress = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        animator = null
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val boxSize = (minOf(w, h) * 0.66f).coerceAtMost(SilkUi.dpF(context, 280f))
        val cx = w * 0.5f
        val cy = h * 0.44f
        val half = boxSize * 0.5f
        val radius = SilkUi.dpF(context, 24f)
        boxRect.set(cx - half, cy - half, cx + half, cy + half)

        if (w != lastW || h != lastH) {
            lastW = w
            lastH = h
            val indigo = SilkUi.color(context, R.color.accent_indigo)
            val blue = SilkUi.color(context, R.color.accent)
            val violet = SilkUi.color(context, R.color.accent_violet)
            val rose = SilkUi.color(context, R.color.accent_rose)
            cornerPaint.shader = LinearGradient(
                boxRect.left, boxRect.top, boxRect.right, boxRect.bottom,
                intArrayOf(blue, violet, rose, indigo),
                floatArrayOf(0f, 0.38f, 0.72f, 1f),
                Shader.TileMode.CLAMP
            )
            beamLinePaint.shader = LinearGradient(
                boxRect.left, 0f, boxRect.right, 0f,
                intArrayOf(Color.TRANSPARENT, blue, violet, rose, Color.TRANSPARENT),
                floatArrayOf(0f, 0.22f, 0.55f, 0.8f, 1f),
                Shader.TileMode.CLAMP
            )
            beamLinePaint.strokeWidth = SilkUi.dpF(context, 2f)
        }

        canvas.drawRect(0f, 0f, w, h, maskPaint)
        canvas.drawRoundRect(boxRect, radius, radius, clearPaint)
        canvas.drawRoundRect(boxRect, radius, radius, borderPaint)

        // Silk 极光扫描光带与高光线（仅在取景框内绘制）
        val violet = SilkUi.color(context, R.color.accent_violet)
        val beamY = boxRect.top + SilkUi.dpF(context, 20f) + (boxRect.height() - SilkUi.dpF(context, 40f)) * beamProgress
        val beamH = SilkUi.dpF(context, 28f)
        val bxL = boxRect.left + SilkUi.dpF(context, 16f)
        val bxR = boxRect.right - SilkUi.dpF(context, 16f)
        beamRect.set(bxL, beamY - beamH, bxR, beamY)
        beamPaint.shader = LinearGradient(
            0f, beamRect.top, 0f, beamRect.bottom,
            intArrayOf(Color.TRANSPARENT, ColorUtils.setAlphaComponent(violet, 88)),
            floatArrayOf(0f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.drawRect(beamRect, beamPaint)
        canvas.drawLine(bxL, beamY, bxR, beamY, beamLinePaint)

        // 四角圆润角标
        val cLen = SilkUi.dpF(context, 22f)
        val l = boxRect.left
        val t = boxRect.top
        val r = boxRect.right
        val b = boxRect.bottom
        // 左上
        canvas.drawLine(l, t + radius, l, t + radius + cLen, cornerPaint)
        canvas.drawArc(l, t, l + radius * 2, t + radius * 2, 180f, 90f, false, cornerPaint)
        canvas.drawLine(l + radius, t, l + radius + cLen, t, cornerPaint)
        // 右上
        canvas.drawLine(r - radius - cLen, t, r - radius, t, cornerPaint)
        canvas.drawArc(r - radius * 2, t, r, t + radius * 2, 270f, 90f, false, cornerPaint)
        canvas.drawLine(r, t + radius, r, t + radius + cLen, cornerPaint)
        // 右下
        canvas.drawLine(r, b - radius - cLen, r, b - radius, cornerPaint)
        canvas.drawArc(r - radius * 2, b - radius * 2, r, b, 0f, 90f, false, cornerPaint)
        canvas.drawLine(r - radius - cLen, b, r - radius, b, cornerPaint)
        // 左下
        canvas.drawLine(l + radius, b, l + radius + cLen, b, cornerPaint)
        canvas.drawArc(l, b - radius * 2, l + radius * 2, b, 90f, 90f, false, cornerPaint)
        canvas.drawLine(l, b - radius - cLen, l, b - radius, cornerPaint)
    }
}
