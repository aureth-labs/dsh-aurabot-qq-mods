package com.aureth.aurabot.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder

/**
 * Aurabot 手机端的安卓壳。
 *
 * 界面和功能都在电脑上「手机端」模块的网页里；这个壳只补网页在手机浏览器里做不到的几件事：
 *  - 局域网 http 下也能录音：经本机 127.0.0.1 转发打开网页（见 [Forwarder]）；
 *  - 原生扫码配对（见 [ScanActivity]）；
 *  - 系统通知（WebView 没有网页通知）；
 *  - 换电脑时先清掉旧电脑留下的全部本地存储，再打开新电脑，令牌不会泄露。
 */
class MainActivity : AppCompatActivity() {
    private enum class NativeScreen { NONE, SETUP, OFFLINE }

    private val prefs by lazy { getSharedPreferences("aurabot", Context.MODE_PRIVATE) }
    @Volatile private var server: Server? = null
    private var web: WebView? = null
    private var progressBar: SilkProgressBar? = null
    private var pageReady = false
    private var switchEpoch = 0
    private var activeLoadEpoch = 0
    private var pendingPermission: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private lateinit var rootContainer: FrameLayout
    private lateinit var pageContainer: FrameLayout
    private var nativeScreen = NativeScreen.NONE
    private var offlineTitle = ""
    private var offlineReason = ""
    private var offlineTarget: Server? = null
    private var pasteExpanded = false
    private var pasteDraft = ""
    private var setupInlineError = ""
    private var pasteInputView: EditText? = null

    private val scanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        when (result.resultCode) {
            Activity.RESULT_OK -> {
                val raw = result.data?.getStringExtra(ScanActivity.EXTRA_QR_RESULT).orEmpty()
                if (raw.isNotEmpty()) onScanned(raw)
            }
            ScanActivity.RESULT_MANUAL_PASTE -> showPasteModalOrExpand()
        }
    }

    private val fileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }

    private val mediaPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val request = pendingPermission ?: return@registerForActivityResult
        pendingPermission = null
        if (!isOurPage(request.origin?.toString())) {
            request.deny()
            return@registerForActivityResult
        }
        val allowed = request.resources.filter {
            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && hasPermissionFor(it)
        }.toTypedArray()
        if (allowed.isNotEmpty()) request.grant(allowed) else request.deny()
    }

    private val notificationPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        refreshNotificationInfo()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applySystemBars()
        createNotificationChannel()

        rootContainer = FrameLayout(this).apply {
            setBackgroundColor(SilkUi.color(context, R.color.bg))
        }
        pageContainer = FrameLayout(this)
        rootContainer.addView(pageContainer, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))
        setContentView(rootContainer)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) {
                    w.goBack()
                } else if (nativeScreen == NativeScreen.SETUP && offlineTarget != null) {
                    showOffline(offlineTarget, offlineTitle.ifEmpty { "连不上电脑" }, offlineReason)
                } else {
                    moveTaskToBack(true)
                }
            }
        })

        val saved = savedServer()
        if (saved == null) {
            showSetup(animate = false)
        } else {
            open(saved, botQuery(intent), animate = false)
        }

        if (savedInstanceState == null) {
            playColdStartSplash()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val botId = intent.getStringExtra(EXTRA_BOT) ?: return
        val w = web
        if (w != null && pageReady) {
            w.evaluateJavascript("typeof openNotificationChat==='function'&&openNotificationChat(${JSONObject.quote(botId)})", null)
        } else {
            (server ?: savedServer())?.let { open(it, botQuery(intent)) }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applySystemBars()
        rootContainer.setBackgroundColor(SilkUi.color(this, R.color.bg))
        web?.setBackgroundColor(SilkUi.color(this, R.color.bg))
        progressBar?.refreshThemeColors()

        // 若当前展示原生页面，随深浅模式立即重绘并保留输入草稿
        pasteDraft = pasteInputView?.text?.toString() ?: pasteDraft
        when (nativeScreen) {
            NativeScreen.SETUP -> showSetup(animate = false)
            NativeScreen.OFFLINE -> showOffline(offlineTarget, offlineTitle, offlineReason, animate = false)
            NativeScreen.NONE -> {}
        }
    }

    // 页面在后台时要报 document.hidden，网页才会发通知；WebView.onPause 不暂停 JS。
    override fun onPause() { super.onPause(); web?.onPause() }
    override fun onResume() { super.onResume(); web?.onResume(); refreshNotificationInfo() }

    override fun onDestroy() {
        pendingPermission?.deny()
        pendingPermission = null
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        destroyWebView()
        if (isFinishing) Forwarder.stopAll()
        super.onDestroy()
    }

    // ---------------- 系统栏与冷启动动画 ----------------

    private fun isNightMode(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    private fun applySystemBars() {
        val bg = SilkUi.color(this, R.color.bg)
        @Suppress("DEPRECATION")
        window.statusBarColor = bg
        @Suppress("DEPRECATION")
        window.navigationBarColor = bg
        val light = !isNightMode()
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }
    }

    /** 冷启动品牌极光流光动画（520ms < 600ms），无停留直接进内容。 */
    private fun playColdStartSplash() {
        val splash = FrameLayout(this).apply {
            setBackgroundColor(SilkUi.color(context, R.color.bg))
            isClickable = true
            isFocusable = true
        }
        splash.addView(AuroraBackdropView(this), FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        val stack = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        val mark = BrandMarkView(this)
        val badge = SilkUi.liquidCircleBadge(this, 76f, mark)
        stack.addView(badge)
        stack.addView(SilkUi.space(this, 16f))
        val wordmark = SilkIntroWordmarkView(this)
        stack.addView(wordmark, LinearLayout.LayoutParams(
            SilkUi.dp(this, 180f),
            SilkUi.dp(this, 56f)
        ))

        splash.addView(stack, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        ))
        rootContainer.addView(splash, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))
        wordmark.playAuroraSweep {}
        mark.playColdStart {
            if (isDestroyed || isFinishing) return@playColdStart
            splash.animate()
                .alpha(0f)
                .setDuration(160L)
                .setInterpolator(SilkUi.EASE_OUT)
                .withEndAction { rootContainer.removeView(splash) }
                .start()
        }
    }

    // ---------------- 配对和打开 ----------------

    private fun savedServer(): Server? =
        prefs.getString(KEY_SERVER, null)?.let { runCatching { Server.parse(it) }.getOrNull() }

    private fun open(target: Server, query: String = "", animate: Boolean = true) {
        if (target.secure) {
            Forwarder.stopAll()
        } else {
            try {
                Forwarder.ensure(target.host, target.port)
            } catch (e: IOException) {
                showOffline(
                    target = target,
                    title = "手机本机端口被占用",
                    reason = "无法打开本机转发端口 ${Forwarder.LOCAL_PORT}（${e.message ?: "请稍后重试"}）。",
                    animate = animate
                )
                return
            }
        }
        server = target
        prefs.edit().putString(KEY_SERVER, target.origin).putBoolean(KEY_HAD_WEB, true).apply()
        nativeScreen = NativeScreen.NONE
        offlineTarget = null
        val loadEpoch = ++activeLoadEpoch
        val w = ensureWebView(animate)
        pageReady = false
        progressBar?.startLoading()
        w.loadUrl(target.base + "/" + query)
        // 若是同 URL 重载，避免 activeLoadEpoch 被误认为旧请求
        w.tag = loadEpoch
    }

    /** 换到另一台电脑：先销毁旧页、停掉转发并确保清完 WebStorage/Cookie，再打开新电脑。 */
    private fun switchServer(target: Server, code: String?) {
        val old = server
        if (old != null && old.origin == target.origin) {
            open(target, codeQuery(code))
            return
        }
        val hadWeb = prefs.getBoolean(KEY_HAD_WEB, false) || web != null || old != null
        val epoch = ++switchEpoch
        activeLoadEpoch++
        server = null
        prefs.edit().remove(KEY_SERVER).apply()
        pendingPermission?.deny()
        pendingPermission = null
        destroyWebView()
        Forwarder.stopAll()

        if (!hadWeb) {
            open(target, codeQuery(code))
            return
        }

        var opened = false
        fun proceed() {
            if (opened || epoch != switchEpoch || isDestroyed || isFinishing) return
            opened = true
            prefs.edit().putBoolean(KEY_HAD_WEB, false).apply()
            open(target, codeQuery(code))
        }

        val cm = CookieManager.getInstance()
        cm.removeAllCookies { cm.flush() }
        val ws = WebStorage.getInstance()
        ws.deleteAllData()
        // Chromium WebStorage.getOrigins 排队在 deleteAllData 之后，确保删除落盘后再加载新页面；附带超时兜底避免冷启卡住。
        Handler(Looper.getMainLooper()).postDelayed({ proceed() }, 1500L)
        ws.getOrigins {
            runOnUiThread { proceed() }
        }
    }

    private fun onScanned(raw: String) {
        try {
            val pairing = Pairing.parse(raw)
            SilkUi.hapticConfirm(rootContainer)
            switchServer(pairing.server, pairing.code)
        } catch (e: IllegalArgumentException) {
            val msg = "二维码不认识：${e.message}"
            if (web == null) {
                setupInlineError = msg
                pasteExpanded = true
                showSetup(animate = false)
            } else {
                toast(msg)
            }
        }
    }

    private fun startScan() {
        val intent = Intent(this, ScanActivity::class.java)
        scanLauncher.launch(intent)
        @Suppress("DEPRECATION")
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }

    // ---------------- 首次配对页 & 连不上状态页 ----------------

    private fun showSetup(animate: Boolean = true) {
        destroyWebView()
        nativeScreen = NativeScreen.SETUP
        val ctx = this

        val wrap = FrameLayout(ctx).apply {
            setBackgroundColor(SilkUi.color(ctx, R.color.bg))
        }
        wrap.addView(AuroraBackdropView(ctx), FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(SilkUi.dp(ctx, 24f), SilkUi.dp(ctx, 56f), SilkUi.dp(ctx, 24f), SilkUi.dp(ctx, 32f))
        }

        val inner = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            val maxW = SilkUi.dp(ctx, 440f)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
            }
            if (resources.displayMetrics.widthPixels > maxW + SilkUi.dp(ctx, 48f)) {
                layoutParams.width = maxW
            }
        }

        // 顶部液态玻璃圆章（呼应 Silk 欢迎/锁定页居中微光圆章）
        val badgeWrap = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        badgeWrap.addView(SilkUi.liquidCircleBadge(ctx, 68f, BrandMarkView(ctx)))
        badgeWrap.addView(TextView(ctx).apply {
            text = "Aura"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            typeface = Typeface.create(Typeface.SERIF, Typeface.BOLD_ITALIC)
            setTextColor(SilkUi.color(ctx, R.color.fg))
            alpha = 0.86f
            setPadding(SilkUi.dp(ctx, 14f), 0, 0, 0)
        })
        inner.addView(badgeWrap)
        inner.addView(SilkUi.space(ctx, 24f))

        // 大标题（28sp 粗体 + 紧凑字距）
        inner.addView(TextView(ctx).apply {
            text = "连上电脑上的她"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
            setTextColor(SilkUi.color(ctx, R.color.fg))
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = -0.02f
            setLineSpacing(0f, 1.18f)
        })
        inner.addView(SilkUi.space(ctx, 10f))

        // 精简引导语（15sp）
        inner.addView(TextView(ctx).apply {
            text = "扫一下电脑面板里的配对二维码，手机就能随时和她聊天、听见她的回复。"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(SilkUi.color(ctx, R.color.muted))
            setLineSpacing(0f, 1.48f)
        })
        inner.addView(SilkUi.space(ctx, 24f))

        // Silk 风格分组说明卡（22dp 液态玻璃 + 36dp 柔和色块图标 + 发丝分割线）
        val guideCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = SilkUi.glassCardBackground(ctx, 22f)
            elevation = SilkUi.dpF(ctx, 2f)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                outlineSpotShadowColor = SilkUi.color(ctx, R.color.stroke)
                outlineAmbientShadowColor = SilkUi.color(ctx, R.color.stroke)
            }
        }
        guideCard.addView(SilkUi.settingRow(
            ctx,
            R.drawable.ic_desktop,
            "电脑开启手机端",
            "打开面板「手机端」，点击「开启并生成二维码」"
        ))
        guideCard.addView(SilkUi.hairlineDivider(ctx))
        guideCard.addView(SilkUi.settingRow(
            ctx,
            R.drawable.ic_wifi,
            "保持网络互通",
            "手机和电脑连在同一局域网，或都在 Tailscale 中"
        ))
        inner.addView(guideCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        inner.addView(SilkUi.space(ctx, 28f))

        // Silk 主按钮：浅色墨黑 / 深色珍珠白胶囊
        val scanBtn = SilkUi.primaryButton(ctx, "扫码配对", R.drawable.ic_qr) { startScan() }
        inner.addView(scanBtn, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        // 若是从断连状态点「换一台电脑」过来的，给一个温和的返回重试入口
        val backTarget = offlineTarget
        if (backTarget != null) {
            inner.addView(SilkUi.space(ctx, 12f))
            inner.addView(SilkUi.secondaryButton(ctx, "继续连回 ${backTarget.origin}", outlined = true) {
                open(backTarget)
            }, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }

        inner.addView(SilkUi.space(ctx, 14f))

        // 次要位置：折叠的粘贴入口
        val pasteCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(SilkUi.dp(ctx, 18f), SilkUi.dp(ctx, 18f), SilkUi.dp(ctx, 18f), SilkUi.dp(ctx, 18f))
            background = SilkUi.glassCardBackground(ctx, 22f)
            elevation = SilkUi.dpF(ctx, 2f)
            visibility = if (pasteExpanded) View.VISIBLE else View.GONE
        }

        val toggleBtn = SilkUi.secondaryButton(ctx, if (pasteExpanded) "收起手动输入" else "扫不了？粘贴二维码文字", outlined = false) { btn ->
            pasteExpanded = !pasteExpanded
            (btn as TextView).text = if (pasteExpanded) "收起手动输入" else "扫不了？粘贴二维码文字"
            if (pasteExpanded) {
                pasteCard.visibility = View.VISIBLE
                SilkUi.animateEnter(pasteCard)
            } else {
                pasteCard.visibility = View.GONE
            }
        }
        inner.addView(toggleBtn, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        pasteCard.addView(TextView(ctx).apply {
            text = "把电脑面板二维码下方显示的配对文字粘贴进来："
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            setTextColor(SilkUi.color(ctx, R.color.muted))
            setLineSpacing(0f, 1.4f)
        })
        pasteCard.addView(SilkUi.space(ctx, 10f))

        val input = SilkUi.styledInput(ctx, "http://电脑地址:32180/?code=…").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            if (pasteDraft.isNotEmpty()) setText(pasteDraft)
        }
        pasteInputView = input
        pasteCard.addView(input, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        val inlineErr = TextView(ctx).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(SilkUi.color(ctx, R.color.error))
            setLineSpacing(0f, 1.35f)
            visibility = if (setupInlineError.isNotEmpty()) View.VISIBLE else View.GONE
            text = setupInlineError
        }
        pasteCard.addView(SilkUi.space(ctx, 8f))
        pasteCard.addView(inlineErr)
        pasteCard.addView(SilkUi.space(ctx, 12f))

        pasteCard.addView(SilkUi.primaryButton(ctx, "连接") { v ->
            val raw = input.text.toString()
            pasteDraft = raw
            try {
                val pairing = Pairing.parse(raw)
                setupInlineError = ""
                inlineErr.visibility = View.GONE
                SilkUi.hapticConfirm(v)
                switchServer(pairing.server, pairing.code)
            } catch (e: IllegalArgumentException) {
                setupInlineError = e.message ?: "这段内容不认识，请核对后重试"
                inlineErr.text = setupInlineError
                inlineErr.visibility = View.VISIBLE
            }
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        inner.addView(SilkUi.space(ctx, 8f))
        inner.addView(pasteCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        col.addView(inner)
        wrap.addView(ScrollView(ctx).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            addView(col)
        })
        showPageView(wrap, animate)
    }

    private fun showOffline(target: Server?, title: String, reason: String, animate: Boolean = true) {
        destroyWebView()
        nativeScreen = NativeScreen.OFFLINE
        offlineTarget = target
        offlineTitle = title
        offlineReason = reason
        pasteInputView = null
        val ctx = this

        val wrap = FrameLayout(ctx).apply {
            setBackgroundColor(SilkUi.color(ctx, R.color.bg))
        }
        wrap.addView(AuroraBackdropView(ctx), FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(SilkUi.dp(ctx, 24f), SilkUi.dp(ctx, 48f), SilkUi.dp(ctx, 24f), SilkUi.dp(ctx, 32f))
        }

        val inner = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            val maxW = SilkUi.dp(ctx, 440f)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
            }
            if (resources.displayMetrics.widthPixels > maxW + SilkUi.dp(ctx, 48f)) {
                layoutParams.width = maxW
            }
        }

        // Silk 液态玻璃离线图标圆章
        val statusIcon = ImageView(ctx).apply {
            setImageResource(R.drawable.ic_offline)
            setColorFilter(SilkUi.color(ctx, R.color.error))
        }
        val iconWrap = FrameLayout(ctx).apply {
            val iconSize = SilkUi.dp(ctx, 28f)
            addView(statusIcon, FrameLayout.LayoutParams(iconSize, iconSize, Gravity.CENTER))
        }
        inner.addView(SilkUi.liquidCircleBadge(ctx, 68f, iconWrap))
        inner.addView(SilkUi.space(ctx, 22f))

        inner.addView(TextView(ctx).apply {
            text = title
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
            setTextColor(SilkUi.color(ctx, R.color.fg))
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = -0.02f
            setLineSpacing(0f, 1.18f)
        })

        if (target != null) {
            inner.addView(SilkUi.space(ctx, 12f))
            val originPill = TextView(ctx).apply {
                text = target.origin
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setTextColor(SilkUi.color(ctx, R.color.muted))
                setPadding(SilkUi.dp(ctx, 14f), SilkUi.dp(ctx, 7f), SilkUi.dp(ctx, 14f), SilkUi.dp(ctx, 7f))
                background = SilkUi.pillBackground(ctx)
                maxLines = 2
            }
            inner.addView(originPill, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }

        inner.addView(SilkUi.space(ctx, 18f))

        // Silk 原因卡片（22dp 液态玻璃 + 分组行）
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = SilkUi.glassCardBackground(ctx, 22f)
            elevation = SilkUi.dpF(ctx, 2f)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                outlineSpotShadowColor = SilkUi.color(ctx, R.color.stroke)
                outlineAmbientShadowColor = SilkUi.color(ctx, R.color.stroke)
            }
        }
        card.addView(SilkUi.settingRow(
            ctx,
            R.drawable.ic_offline,
            "连接中断原因",
            reason,
            isError = true
        ))
        inner.addView(card, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        inner.addView(SilkUi.space(ctx, 28f))

        // 主按钮：重新连接
        if (target != null) {
            inner.addView(SilkUi.primaryButton(ctx, "重新连接") { open(target) }, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
            inner.addView(SilkUi.space(ctx, 12f))
        }

        // 次按钮：换一台电脑
        inner.addView(SilkUi.secondaryButton(ctx, "换一台电脑", outlined = true) {
            pasteExpanded = false
            setupInlineError = ""
            showSetup(animate = true)
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        col.addView(inner)
        wrap.addView(ScrollView(ctx).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            addView(col)
        })
        showPageView(wrap, animate)
    }

    /** 网页内扫码时选择了「改为粘贴二维码文字」：弹出简洁的 20dp 圆角输入卡片。 */
    private fun showPasteModalOrExpand() {
        if (web == null) {
            pasteExpanded = true
            setupInlineError = ""
            showSetup(animate = true)
            return
        }
        val ctx = this
        val dialog = Dialog(ctx)
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(SilkUi.dp(ctx, 22f), SilkUi.dp(ctx, 22f), SilkUi.dp(ctx, 22f), SilkUi.dp(ctx, 20f))
            background = SilkUi.glassCardBackground(ctx, 24f)
            elevation = SilkUi.dpF(ctx, 8f)
        }
        card.addView(TextView(ctx).apply {
            text = "粘贴配对内容"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            setTextColor(SilkUi.color(ctx, R.color.fg))
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = -0.01f
        })
        card.addView(SilkUi.space(ctx, 8f))
        card.addView(TextView(ctx).apply {
            text = "把电脑面板「手机端」二维码下方显示的文字粘贴到这里。"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(SilkUi.color(ctx, R.color.muted))
            setLineSpacing(0f, 1.4f)
        })
        card.addView(SilkUi.space(ctx, 14f))

        val input = SilkUi.styledInput(ctx, "http://电脑地址:32180/?code=…").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
        }
        card.addView(input, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        val errText = TextView(ctx).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(SilkUi.color(ctx, R.color.error))
            visibility = View.GONE
        }
        card.addView(SilkUi.space(ctx, 8f))
        card.addView(errText)
        card.addView(SilkUi.space(ctx, 14f))

        card.addView(SilkUi.primaryButton(ctx, "连接") { v ->
            try {
                val pairing = Pairing.parse(input.text.toString())
                SilkUi.hapticConfirm(v)
                dialog.dismiss()
                switchServer(pairing.server, pairing.code)
            } catch (e: IllegalArgumentException) {
                errText.text = e.message ?: "内容不认识"
                errText.visibility = View.VISIBLE
            }
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        card.addView(SilkUi.space(ctx, 8f))
        card.addView(SilkUi.secondaryButton(ctx, "取消", outlined = false) {
            dialog.dismiss()
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        val outer = FrameLayout(ctx).apply {
            setPadding(SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 20f), SilkUi.dp(ctx, 20f))
            addView(card, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }
        dialog.setContentView(outer)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(
                (resources.displayMetrics.widthPixels).coerceAtMost(SilkUi.dp(ctx, 440f)),
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        dialog.show()
    }

    private fun showPageView(view: View, animate: Boolean) {
        pageContainer.removeAllViews()
        pageContainer.addView(view, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))
        if (animate) SilkUi.animateEnter(view)
    }

    // ---------------- WebView ----------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureWebView(animate: Boolean): WebView {
        web?.let { return it }
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        val w = WebView(this)
        w.setBackgroundColor(SilkUi.color(this, R.color.bg))
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString AurabotMobile/${appVersion()}"
        }
        w.addJavascriptInterface(Bridge(), "AuraNative")
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url?.toString().orEmpty()
                if (isOurPage(url)) return false
                // 外部子框架导航一律静默拦截；主框架外部链接交给系统浏览器，不留在带原生接口的 WebView 里。
                if (!request.isForMainFrame) return true
                val scheme = request.url?.scheme?.lowercase()
                if (scheme in ALLOWED_EXTERNAL_SCHEMES) {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                }
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                if (isOurPage(url)) progressBar?.startLoading()
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = isOurPage(url)
                progressBar?.finishLoading()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                // 切换/停止加载引起的中止不视为连不上电脑
                if (error.errorCode == ERROR_UNKNOWN && (view.tag as? Int) != activeLoadEpoch) return
                progressBar?.hideImmediately()
                val target = server
                showOffline(
                    target = target,
                    title = "连不上电脑",
                    reason = "请确认电脑开着、Aurabot 的「手机端」已开启，手机和电脑在同一个网络里或同一个 Tailscale 里。"
                )
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (!request.isForMainFrame || errorResponse.statusCode < 500) return
                progressBar?.hideImmediately()
                showOffline(
                    target = server,
                    title = "电脑端暂时打不开",
                    reason = "电脑端返回了异常状态（${errorResponse.statusCode}），可以点下面重新连接，或查看电脑面板日志。"
                )
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // 绝不放行不可信证书，防止令牌泄露。
                handler.cancel()
                progressBar?.hideImmediately()
                showOffline(
                    target = server,
                    title = "HTTPS 证书不被信任",
                    reason = "系统不信任这台电脑的 HTTPS 证书，请改用受信任的证书（如 Tailscale 证书）或局域网二维码重连。"
                )
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar?.setProgressValue(newProgress)
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handlePermission(request) }
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    fileLauncher.launch(params.createIntent())
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        val bar = SilkProgressBar(this)
        val container = FrameLayout(this).apply {
            setBackgroundColor(SilkUi.color(context, R.color.bg))
            addView(w, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            ))
            addView(bar, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                SilkUi.dp(context, 2.5f).coerceAtLeast(3),
                Gravity.TOP
            ))
        }
        progressBar = bar
        web = w
        showPageView(container, animate)
        return w
    }

    private fun destroyWebView() {
        progressBar?.hideImmediately()
        progressBar = null
        web?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.stopLoading()
            it.removeJavascriptInterface("AuraNative")
            it.clearCache(true)
            it.destroy()
        }
        web = null
        pageReady = false
    }

    private fun isOurPage(url: String?): Boolean = server?.matchesWebOrigin(url) == true

    /** 网页要麦克风：只认自己的页面，只给麦克风；系统权限没给就先问。 */
    private fun handlePermission(request: PermissionRequest) {
        if (!isOurPage(request.origin?.toString())) {
            request.deny()
            return
        }
        // 只给麦克风（录语音）。扫码走原生，网页不需要相机，不让它沿用原生扫码拿到的相机权限。
        val wanted = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
        if (wanted.isEmpty()) {
            request.deny()
            return
        }
        val missing = wanted.mapNotNull { androidPermissionFor(it) }.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            request.grant(wanted.toTypedArray())
            return
        }
        pendingPermission?.deny()
        pendingPermission = request
        mediaPermissionLauncher.launch(missing.toTypedArray())
    }

    private fun androidPermissionFor(resource: String) = when (resource) {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
        else -> null
    }

    private fun hasPermissionFor(resource: String): Boolean {
        val p = androidPermissionFor(resource) ?: return false
        return ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
    }

    // ---------------- 通知 ----------------

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_MESSAGES,
            getString(R.string.channel_messages),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            enableVibration(true)
            setShowBadge(true)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun notificationsAllowed(): Boolean {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    private fun notificationStatusText(): String = if (notificationsAllowed())
        "系统通知已允许。App 在后台时收到她的新消息会提醒；App 被系统清掉后收不到，需要重新打开。"
    else
        "还没允许通知。点上方按钮允许后，App 在后台时收到她的新消息会提醒。"

    private fun refreshNotificationInfo() {
        if (pageReady) web?.evaluateJavascript("typeof updateNotificationInfo==='function'&&updateNotificationInfo()", null)
    }

    private fun requestNotifications() {
        if (notificationsAllowed()) { refreshNotificationInfo(); return }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !prefs.getBoolean(KEY_ASKED_NOTIFY, false)
        ) {
            prefs.edit().putBoolean(KEY_ASKED_NOTIFY, true).apply()
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        // 已经拒绝过或在系统里关掉了：只能去系统设置里开。
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    @SuppressLint("MissingPermission")
    private fun postMessage(title: String, body: String, botId: String, id: String) {
        if (!notificationsAllowed()) return
        val senderName = title.takeIf { it.isNotBlank() }?.take(60) ?: "Aurabot"
        val preview = body.take(200)
        val groupKey = "aurabot-$botId"
        val open = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_BOT, botId)
        val pending = PendingIntent.getActivity(
            this,
            botId.hashCode(),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val accentColor = SilkUi.color(this, R.color.accent)
        val manager = NotificationManagerCompat.from(this)

        val messageNotification = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(accentColor)
            .setContentTitle(senderName)
            .setContentText(preview)
            .setStyle(NotificationCompat.BigTextStyle().bigText(preview))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setGroup(groupKey)
            .build()

        val summaryNotification = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(accentColor)
            .setContentTitle(senderName)
            .setContentText(preview)
            .setStyle(NotificationCompat.InboxStyle().setSummaryText(senderName))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setGroup(groupKey)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .build()

        manager.notify(("aurabot-$id").hashCode(), messageNotification)
        manager.notify(("aurabot-summary-$botId").hashCode(), summaryNotification)
    }

    // ---------------- 给网页用的原生接口 ----------------
    // 只有自己的页面能用到：导航严格限制在电脑地址之内，外链交给系统浏览器，且仅暴露于 isOurPage 时。

    private inner class Bridge {
        @JavascriptInterface fun serverOrigin(): String = server?.origin ?: ""

        @JavascriptInterface fun changeServer(href: String) {
            runOnUiThread {
                if (!isOurPage(web?.url)) return@runOnUiThread
                try {
                    val pairing = Pairing.parse(href)
                    switchServer(pairing.server, pairing.code)
                } catch (e: IllegalArgumentException) {
                    toast("地址不对：${e.message}")
                }
            }
        }

        @JavascriptInterface fun scan() {
            runOnUiThread {
                if (!isOurPage(web?.url)) return@runOnUiThread
                startScan()
            }
        }

        @JavascriptInterface fun notificationStatus(): String = notificationStatusText()

        @JavascriptInterface fun requestNotifications() {
            runOnUiThread {
                if (!isOurPage(web?.url)) return@runOnUiThread
                requestNotifications()
            }
        }

        @JavascriptInterface fun notify(title: String?, body: String?, botId: String?, id: String?) {
            val bot = botId ?: return
            runOnUiThread {
                if (!isOurPage(web?.url)) return@runOnUiThread
                postMessage(title ?: "Aurabot", body ?: "", bot, id ?: System.currentTimeMillis().toString())
            }
        }
    }

    // ---------------- 小工具 ----------------

    private fun botQuery(intent: Intent?): String =
        intent?.getStringExtra(EXTRA_BOT)?.let { "?botId=" + URLEncoder.encode(it, "UTF-8") } ?: ""

    private fun codeQuery(code: String?): String = code?.let { "?code=" + URLEncoder.encode(it, "UTF-8") } ?: ""

    private fun appVersion(): String =
        runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "0"

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    companion object {
        private const val KEY_SERVER = "server"
        private const val KEY_HAD_WEB = "hadWeb"
        private const val KEY_ASKED_NOTIFY = "askedNotify"
        private const val CHANNEL_MESSAGES = "messages"
        private val ALLOWED_EXTERNAL_SCHEMES = setOf("http", "https", "mailto", "tel")
        const val EXTRA_BOT = "botId"
    }
}
