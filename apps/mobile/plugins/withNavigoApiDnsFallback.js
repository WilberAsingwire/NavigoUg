const fs = require("node:fs/promises");
const path = require("node:path");
const {
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication
} = require("expo/config-plugins");

const DEPENDENCY = 'com.squareup.okhttp3:okhttp-dnsoverhttps:4.9.2';
const INSTALL_MARKER = "NavigoApiDns.install(this)";

const KOTLIN_SOURCE = (packageName) => `package ${packageName}

import android.content.Context
import android.util.Log
import com.facebook.react.modules.network.OkHttpClientProvider
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.dnsoverhttps.DnsOverHttps

/**
 * Resolves NAVIGO's API with Android's normal DNS first.
 *
 * If the system resolver cannot resolve the API host, this retries through
 * Google DNS-over-HTTPS and then Cloudflare DNS-over-HTTPS. The fallback is
 * deliberately scoped to NAVIGO's API hostname; all other hosts continue to
 * use Android's normal DNS resolver.
 */
internal object NavigoApiDns {
  private const val API_HOST = "navigou-api-2978.onrender.com"
  private const val TAG = "NAVIGO_API_DNS"

  fun install(context: Context) {
    val bootstrapClient = OkHttpClient.Builder()
      .connectTimeout(4, TimeUnit.SECONDS)
      .readTimeout(4, TimeUnit.SECONDS)
      .writeTimeout(4, TimeUnit.SECONDS)
      .build()

    val googleDns = DnsOverHttps.Builder()
      .client(bootstrapClient)
      .url("https://dns.google/dns-query".toHttpUrl())
      .bootstrapDnsHosts(ip(8, 8, 8, 8), ip(8, 8, 4, 4))
      .build()

    val cloudflareDns = DnsOverHttps.Builder()
      .client(bootstrapClient)
      .url("https://cloudflare-dns.com/dns-query".toHttpUrl())
      .bootstrapDnsHosts(ip(1, 1, 1, 1), ip(1, 0, 0, 1))
      .build()

    val navigoDns = object : Dns {
      override fun lookup(hostname: String): List<InetAddress> {
        try {
          return Dns.SYSTEM.lookup(hostname)
        } catch (systemFailure: UnknownHostException) {
          if (!hostname.equals(API_HOST, ignoreCase = true)) {
            throw systemFailure
          }

          Log.w(TAG, "System DNS could not resolve NAVIGO's API; trying Google DNS-over-HTTPS.")

          try {
            return googleDns.lookup(hostname)
          } catch (googleFailure: UnknownHostException) {
            Log.w(TAG, "Google DNS-over-HTTPS failed; trying the secondary resolver.")

            try {
              return cloudflareDns.lookup(hostname)
            } catch (cloudflareFailure: UnknownHostException) {
              cloudflareFailure.addSuppressed(googleFailure)
              cloudflareFailure.addSuppressed(systemFailure)
              throw cloudflareFailure
            }
          }
        }
      }
    }

    // Register before React Native starts so fetch() and XMLHttpRequest use
    // the resolver. The standard React Native client builder preserves its
    // normal cookie handling and HTTP cache.
    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(context.applicationContext)
        .dns(navigoDns)
        .build()
    }
  }

  private fun ip(a: Int, b: Int, c: Int, d: Int): InetAddress =
    InetAddress.getByAddress(
      byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte())
    )
}
`;

function withApiDnsDependency(config) {
  return withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;

    if (!contents.includes(DEPENDENCY)) {
      if (!/dependencies\\s*\\{/.test(contents)) {
        throw new Error(
          "withNavigoApiDnsFallback: could not find the Android app dependencies block."
        );
      }
      contents = contents.replace(
        /dependencies\\s*\\{/,
        (match) => match + `\\n    implementation("${DEPENDENCY}")`
      );
    }

    mod.modResults.contents = contents;
    return mod;
  });
}

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
        onCreateMarker + `\\n    ${INSTALL_MARKER}`
      );
    }

    mod.modResults.contents = contents;
    return mod;
  });
}

function withApiDnsSource(config) {
  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const packageName = mod.modConfig.android?.package;
      if (!packageName) {
        throw new Error(
          "withNavigoApiDnsFallback: android.package must be configured."
        );
      }

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
  config = withApiDnsDependency(config);
  config = withApiDnsMainApplication(config);
  config = withApiDnsSource(config);
  return config;
};
