const fs = require("node:fs/promises");
const path = require("node:path");
const {
  withDangerousMod,
  withMainApplication
} = require("expo/config-plugins");

const INSTALL_MARKER = "NavigoApiDns.install(this)";
const NEWLINE = String.fromCharCode(10);

const KOTLIN_SOURCE = (packageName) => `package ${packageName}

import android.content.Context
import android.util.Log
import com.facebook.react.modules.network.OkHttpClientProvider
import java.io.IOException
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.Locale
import java.util.concurrent.TimeUnit
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/**
 * Resolves NAVIGO's API using Android's normal DNS first.
 *
 * If Android cannot resolve the API hostname, this uses the Google DNS-over-
 * HTTPS JSON endpoint and then Cloudflare's DNS-over-HTTPS JSON endpoint.
 * Resolver bootstrap IPs are hard-coded only for those two resolver hosts;
 * ordinary application traffic and all other DNS lookups keep using the
 * Android system resolver.
 */
internal object NavigoApiDns {
  private const val API_HOST = "navigou-api-2978.onrender.com"
  private const val GOOGLE_HOST = "dns.google"
  private const val CLOUDFLARE_HOST = "cloudflare-dns.com"
  private const val TAG = "NAVIGO_API_DNS"

  fun install(context: Context) {
    val googleBootstrap = listOf(ip(8, 8, 8, 8), ip(8, 8, 4, 4))
    val cloudflareBootstrap = listOf(ip(1, 1, 1, 1), ip(1, 0, 0, 1))

    // Resolve only the two DoH service hostnames through fixed bootstrap IPs.
    // TLS still verifies the original hostname (dns.google / cloudflare-dns.com).
    val bootstrapDns = object : Dns {
      override fun lookup(hostname: String): List<InetAddress> {
        return when (hostname.lowercase(Locale.US)) {
          GOOGLE_HOST -> googleBootstrap
          CLOUDFLARE_HOST -> cloudflareBootstrap
          else -> Dns.SYSTEM.lookup(hostname)
        }
      }
    }

    // Use OkHttp already supplied by React Native; no additional DNS library
    // or alternate OkHttp version is added to NAVIGO's dependency graph.
    val dohClient = OkHttpClient.Builder()
      .dns(bootstrapDns)
      .connectTimeout(4, TimeUnit.SECONDS)
      .readTimeout(4, TimeUnit.SECONDS)
      .writeTimeout(4, TimeUnit.SECONDS)
      .build()

    val navigoDns = object : Dns {
      override fun lookup(hostname: String): List<InetAddress> {
        try {
          return Dns.SYSTEM.lookup(hostname)
        } catch (systemFailure: UnknownHostException) {
          if (!hostname.equals(API_HOST, ignoreCase = true)) {
            throw systemFailure
          }

          Log.w(TAG, "System DNS could not resolve NAVIGO's API; trying Google DoH.")

          var googleFailure: UnknownHostException? = null
          try {
            return queryDoh(dohClient, GOOGLE_HOST, "resolve", hostname)
          } catch (failure: UnknownHostException) {
            googleFailure = failure
            Log.w(TAG, "Google DoH failed; trying Cloudflare DoH.")
          }

          try {
            return queryDoh(dohClient, CLOUDFLARE_HOST, "dns-query", hostname)
          } catch (cloudflareFailure: UnknownHostException) {
            cloudflareFailure.addSuppressed(systemFailure)
            googleFailure?.let { cloudflareFailure.addSuppressed(it) }
            throw cloudflareFailure
          }
        }
      }
    }

    // Register before React Native starts so fetch() and XMLHttpRequest use
    // the scoped resolver while retaining React Native's normal client setup.
    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(context.applicationContext)
        .dns(navigoDns)
        .build()
    }
  }

  private fun queryDoh(
    client: OkHttpClient,
    resolverHost: String,
    endpointPath: String,
    hostname: String
  ): List<InetAddress> {
    try {
      val url = "https://\${resolverHost}/\${endpointPath}".toHttpUrl()
        .newBuilder()
        .addQueryParameter("name", hostname)
        .addQueryParameter("type", "A")
        .build()

      val request = Request.Builder()
        .url(url)
        .header("Accept", "application/dns-json")
        .get()
        .build()

      val payload = client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
          throw IOException("DoH resolver returned HTTP \${response.code}")
        }
        response.body?.string()
          ?: throw IOException("DoH resolver returned an empty response")
      }

      val answers = JSONObject(payload).optJSONArray("Answer")
      val addresses = mutableListOf<InetAddress>()
      if (answers != null) {
        for (index in 0 until answers.length()) {
          val answer = answers.optJSONObject(index) ?: continue
          if (answer.optInt("type") != 1) continue

          val value = answer.optString("data").trim()
          if (value.isEmpty()) continue

          val address = InetAddress.getByName(value)
          if (addresses.none { it.hostAddress == address.hostAddress }) {
            addresses.add(address)
          }
        }
      }

      if (addresses.isEmpty()) {
        throw UnknownHostException("DoH returned no IPv4 address for \${hostname}")
      }
      return addresses
    } catch (failure: Exception) {
      if (failure is UnknownHostException) throw failure
      val wrapped = UnknownHostException(
        "DoH lookup failed for \${hostname} using \${resolverHost}"
      )
      wrapped.initCause(failure)
      throw wrapped
    }
  }

  private fun ip(a: Int, b: Int, c: Int, d: Int): InetAddress =
    InetAddress.getByAddress(
      byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte())
    )
}
`;

function withApiDnsMainApplication(config) {
  return withMainApplication(config, (mod) => {
    if (mod.modResults.language !== "kt") {
      throw new Error(
        "withNavigoApiDnsFallback: expected the Expo Android MainApplication to be Kotlin."
      );
    }

    let contents = mod.modResults.contents;

    if (!contents.includes(INSTALL_MARKER)) {
      const onCreateMarker = "    super.onCreate()";
      if (!contents.includes(onCreateMarker)) {
        throw new Error(
          "withNavigoApiDnsFallback: could not find super.onCreate() in MainApplication."
        );
      }
      contents = contents.replace(
        onCreateMarker,
        onCreateMarker + NEWLINE + "    " + INSTALL_MARKER
      );
    }

    mod.modResults.contents = contents;
    return mod;
  });
}

function withApiDnsSource(config) {
  const packageName = config.android && config.android.package;
  if (!packageName) {
    throw new Error(
      "withNavigoApiDnsFallback: android.package must be configured."
    );
  }

  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const packageDirectory = path.join(
        mod.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "java",
        ...packageName.split(".")
      );

      await fs.mkdir(packageDirectory, { recursive: true });
      await fs.writeFile(
        path.join(packageDirectory, "NavigoApiDns.kt"),
        KOTLIN_SOURCE(packageName),
        "utf8"
      );

      return mod;
    }
  ]);
}

module.exports = function withNavigoApiDnsFallback(config) {
  config = withApiDnsMainApplication(config);
  config = withApiDnsSource(config);
  return config;
};
