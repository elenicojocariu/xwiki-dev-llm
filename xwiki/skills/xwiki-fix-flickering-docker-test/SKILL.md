---
name: xwiki-fix-flickering-docker-test
description: Guide for fixing a flickering Docker-based functional test for an XWiki module.
---

**Read first, before editing any test:** the rules the steps below depend on are not repeated here — `okf/testing/strategy.md` for the **page-object boundary** (the fix goes in a page object, never as a `getDriver()` call in the test class) and the don't-pay-the-timeout rule, and `okf/testing/running-docker-its.md` for the JDK-on-`PATH` and :8080 prerequisites that otherwise surface as "Failed to start XWiki in [N] seconds".

When the flicker was seen on CI (ci.xwiki.org), start with the ``develocity`` MCP rather than with Jenkins: it holds the test method's failure history across builds (how often it fails, since when) and the stack trace and output of each failed run, which is what you try to reproduce below. There is no Develocity data for `xwiki-contrib` repos, so for those go to Jenkins (`okf/servers/jenkins.md`) and fetch the failing method's archived screenshot **and video** — running the video through scene detection localises the failure to the frame, which beats reasoning from the stack trace.

1. Build the modified Maven projects, excluding those with ``-docker`` and ``-tests`` suffix.
2. Replace the ``@Test`` annotation with ``@org.junit.jupiter.api.RepeatedTest(value = 10, failureThreshold = 1)`` only for the flickering test method.
3. Check if there is an XWiki instance already running on port 8080, in which case ask for confirmation to stop it.
4. Try to reproduce the flickering on Firefox with ``mvn clean install -B -ntp -Dit.test=TestClass#testMethod -Dxwiki.test.ui.browser=firefox``; this creates a new XWiki test instance
5. Analyze the logs to understand the failure.
6. Start the XWiki test instance in the background with ``./target/hsqldb_embedded-default-default-jetty_standalone-default-firefox/jetty/start_xwiki.sh``, run **from its own directory** (its paths are relative). Reusing the provisioned instance this way is what makes an iteration take seconds instead of minutes, so do it before iterating on a fix. Stop it with ``./stop_xwiki.sh`` there.
7. Run the repeated test on Chrome as well, against the running XWiki test instance, to check if the failure is the same:

  ```
  mvn compiler:testCompile failsafe:integration-test -B -ntp -Dxwiki.test.ui.servletEngine=external -Dit.test=TestClass#testMethod -Dxwiki.test.ui.browser=chrome
  ```

  ``failsafe:integration-test`` does not recompile test sources, so without ``compiler:testCompile`` this silently re-runs the previously compiled test.

8. Identify the failure reason then update the test and/or the used page objects in order to fix the flickering. **The change belongs in a page object** whenever it drives the UI — per the page-object boundary above, and because a fix in the page object also fixes every other test using it.
9. Always validate the fix by running the flickering test at least 10 times on both Firefox and Chrome.
10. If the fix requires changes outside the ``-docker`` and ``-pageobjects`` projects then go to step 1 (to recreate the XWiki test instance); otherwise:
  * Rebuild the modified ``-pageobjects`` projects
  * Compile the test code with ``mvn compiler:testCompile -B -ntp``
  * Run the flickering test method against the running XWiki test instance like in step 7 and iterate
11. Stop the XWiki test instance at the end.