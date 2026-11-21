// DropWave in Hindi (and later other languages): translates what's on screen, both in the PC app
// and on the phone page. Exact English strings and a few patterns are swapped for the chosen
// language as the page renders; anything without a translation stays in English.
//   window.DWTranslate.set('hi' | 'en')
(function () {
  const HI = {
    // ---- navigation & pages ----
    'Home': 'होम', 'Photos': 'फ़ोटो', 'Messages': 'मैसेज', 'Contacts': 'संपर्क', 'Apps': 'ऐप्स', 'Phone files': 'फ़ोन की फ़ाइलें',
    'Nearby': 'आस-पास', 'Chats': 'चैट', 'Activity': 'गतिविधि', 'Settings': 'सेटिंग्स', 'Nearby devices': 'आस-पास के डिवाइस',
    'Received files': 'आई हुई फ़ाइलें', 'Search commands…': 'कमांड खोजें…', 'Type a command or a device…': 'कमांड या डिवाइस लिखें…',
    'Your phone, right here on your PC': 'आपका फ़ोन, यहीं आपके PC पर', 'Bring your phone to your PC': 'अपना फ़ोन PC पर लाएँ',
    'Personalise how DropWave works on this computer': 'इस कंप्यूटर पर DropWave को अपने हिसाब से चलाएँ',
    // ---- home ----
    'Connected': 'जुड़ा है', 'Encrypted': 'एन्क्रिप्टेड', 'Screen': 'स्क्रीन', 'Send files': 'फ़ाइलें भेजें', 'Clipboard': 'क्लिपबोर्ड',
    'Find phone': 'फ़ोन ढूँढें', 'Call': 'कॉल', 'Stop': 'रोकें', 'Notifications': 'सूचनाएँ', 'Clear all': 'सब हटाएँ', 'Reply': 'जवाब दें',
    'Mark as read': 'पढ़ा हुआ करें', 'Dismiss': 'हटाएँ', 'Copy code': 'कोड कॉपी करें', 'Nothing playing': 'कुछ नहीं चल रहा',
    'Music and videos on the phone show up here': 'फ़ोन के गाने और वीडियो यहाँ दिखते हैं', 'Phone volume': 'फ़ोन की आवाज़',
    'Recent calls': 'हाल की कॉल', 'Dial': 'डायल', 'Missed': 'मिस्ड', 'Incoming': 'आने वाली', 'Outgoing': 'जाने वाली', 'No recent calls.': 'हाल में कोई कॉल नहीं।',
    'Phone controls': 'फ़ोन कंट्रोल', 'Torch': 'टॉर्च', 'DND': 'DND', 'Ring': 'रिंग', 'Vibrate': 'वाइब्रेट', 'Silent': 'साइलेंट', 'Lock': 'लॉक',
    'Ringtone': 'रिंगटोन', 'Alarms': 'अलार्म', 'Brightness': 'ब्राइटनेस', 'Auto': 'ऑटो', 'Asking the phone…': 'फ़ोन से पूछ रहे हैं…',
    'Camera': 'कैमरा', 'Take photo': 'फ़ोटो लें', 'Video': 'वीडियो', 'Webcam': 'वेबकैम', 'photo, video or live webcam': 'फ़ोटो, वीडियो या लाइव वेबकैम',
    'Timeline': 'टाइमलाइन', 'View all': 'सब देखें', 'See all': 'सब देखें', 'Connect phone': 'फ़ोन जोड़ें', 'Get the Android app': 'Android ऐप लें',
    'Connect the DropWave Android app': 'DropWave Android ऐप जोड़ें', 'Find my phone': 'फ़ोन ढूँढें', 'Touchpad & Deck': 'टचपैड और डेक',
    'Ring it, even on silent': 'साइलेंट पर भी बजाएँ', 'Copy on one, paste on the other': 'एक पर कॉपी, दूसरे पर पेस्ट',
    'May sleep when locked': 'लॉक होने पर सो सकता है', 'No notifications. You’re all caught up.': 'कोई सूचना नहीं। सब देख लिया।',
    // ---- common buttons ----
    'Open': 'खोलें', 'Close': 'बंद करें', 'Cancel': 'रद्द करें', 'Accept': 'स्वीकार करें', 'Decline': 'मना करें', 'Allow': 'अनुमति दें',
    'Allow once': 'एक बार अनुमति दें', 'Always allow': 'हमेशा अनुमति दें', 'Deny': 'मना करें', 'Copy': 'कॉपी', 'Delete': 'मिटाएँ', 'Remove': 'हटाएँ',
    'Rename': 'नाम बदलें', 'Refresh': 'रीफ़्रेश', 'Search': 'खोजें', 'Share': 'शेयर', 'Send': 'भेजें', 'Done': 'हो गया', 'Next': 'अगला',
    'Previous': 'पिछला', 'Play': 'चलाएँ', 'Change': 'बदलें', 'Clear': 'साफ़ करें', 'Try again': 'फिर कोशिश करें', 'Start again': 'फिर शुरू करें',
    'Show in folder': 'फ़ोल्डर में दिखाएँ', 'Open settings': 'सेटिंग्स खोलें', 'Open on the phone': 'फ़ोन पर खोलें', 'New': 'नया', 'Message': 'मैसेज',
    'Download to PC': 'PC पर डाउनलोड करें', 'Check now': 'अभी जाँचें', 'Up': 'ऊपर', 'View': 'देखें', 'Forget': 'भूल जाएँ', 'Answer on the phone': 'फ़ोन पर उठाएँ',
    'Hang up': 'कॉल काटें', 'Copy again': 'फिर कॉपी करें', 'Play it': 'चलाएँ', 'Open link': 'लिंक खोलें', 'Copy address': 'पता कॉपी करें',
    // ---- photos, messages, files, contacts, apps ----
    'All': 'सब', 'Screenshots': 'स्क्रीनशॉट', 'Videos': 'वीडियो', 'Today': 'आज', 'Yesterday': 'कल', 'Auto-backup': 'ऑटो-बैकअप',
    'Auto-backup new photos to this PC': 'नई फ़ोटो अपने आप इस PC पर', 'Open the backup folder': 'बैकअप फ़ोल्डर खोलें',
    'No photos or videos in this view.': 'यहाँ कोई फ़ोटो या वीडियो नहीं।', 'Pick a conversation': 'कोई बातचीत चुनें', 'Text message': 'मैसेज',
    'This folder is empty.': 'यह फ़ोल्डर खाली है।', 'Internal storage': 'फ़ोन स्टोरेज', 'Pick a contact': 'कोई संपर्क चुनें', 'Favourites': 'पसंदीदा',
    'Call from the phone, send an SMS, or copy a number.': 'फ़ोन से कॉल करें, SMS भेजें या नंबर कॉपी करें।',
    'Recent': 'हाल के', 'All apps': 'सभी ऐप्स', 'Search apps': 'ऐप खोजें', 'Name': 'नाम', 'Most used (7 days)': 'सबसे ज़्यादा इस्तेमाल (7 दिन)',
    'Recently updated': 'हाल में अपडेट', 'Recently installed': 'हाल में इंस्टॉल', 'Size': 'साइज़', 'Usage access': 'Usage access',
    'Couldn’t list the apps': 'ऐप्स की लिस्ट नहीं मिली', 'No phone connected': 'कोई फ़ोन नहीं जुड़ा', 'Switched off on the phone': 'फ़ोन पर बंद है',
    'Allow photos on the phone': 'फ़ोन पर फ़ोटो की अनुमति दें', 'Allow messages on the phone': 'फ़ोन पर मैसेज की अनुमति दें',
    'Allow file access on the phone': 'फ़ोन पर फ़ाइलों की अनुमति दें', 'Allow contacts on the phone': 'फ़ोन पर संपर्कों की अनुमति दें',
    // ---- nearby, chats, activity ----
    'Looking for nearby devices…': 'आस-पास के डिवाइस ढूँढ रहे हैं…', 'Connect phone or TV': 'फ़ोन या TV जोड़ें', 'Add by IP': 'IP से जोड़ें',
    'Drop to send': 'भेजने के लिए छोड़ें', 'Transfers': 'ट्रांसफ़र', 'Sent': 'भेजा', 'Received': 'मिला', 'Completed': 'पूरा', 'Failed': 'नहीं हुआ',
    'Cancelled': 'रद्द', 'Declined': 'मना किया', 'Sending…': 'भेज रहे हैं…', 'Waiting for approval': 'मंज़ूरी का इंतज़ार', 'No transfers yet': 'अभी कोई ट्रांसफ़र नहीं',
    'Clear history': 'इतिहास साफ़ करें', 'Start a conversation': 'बातचीत शुरू करें', 'Pick a device to chat with': 'चैट के लिए डिवाइस चुनें',
    // ---- settings ----
    'This device': 'यह डिवाइस', 'Phones & TVs': 'फ़ोन और TV', 'Phone (Android app)': 'फ़ोन (Android ऐप)', 'Appearance': 'दिखावट',
    'Behaviour': 'व्यवहार', 'Trusted devices': 'भरोसेमंद डिवाइस', 'Updates': 'अपडेट', 'Style': 'स्टाइल', 'Accent colour': 'मुख्य रंग',
    'Light': 'लाइट', 'Dark': 'डार्क', 'System': 'सिस्टम', 'Language': 'भाषा', 'Save to': 'यहाँ सेव करें', 'Check for updates': 'अपडेट जाँचें',
    'Restart to update': 'अपडेट के लिए रीस्टार्ट करें', 'Start with Windows': 'Windows के साथ शुरू करें', 'Keep running when closed': 'बंद करने पर भी चलता रहे',
    'Closing the window hides DropWave to the system tray': 'विंडो बंद करने पर DropWave ट्रे में छिप जाता है',
    'Run quietly in the tray so others can always send to you': 'ट्रे में चुपचाप चलता रहे ताकि कोई भी आपको भेज सके',
    'Show a Windows notification for incoming files': 'आने वाली फ़ाइलों पर Windows सूचना दिखाएँ', 'Clipboard sync': 'क्लिपबोर्ड सिंक',
    'Phone notifications on this PC': 'फ़ोन की सूचनाएँ इस PC पर',
    'Connect over a USB cable too': 'USB केबल से भी जोड़ें',
    'Connect over USB or Wireless debugging': 'USB या Wireless debugging से जोड़ें',
    'Also works when the Wi-Fi link is slow, and lets phone apps open in their own windows here. Uses Android’s developer options.': 'Wi-Fi धीमा हो तब भी चलता है, और फ़ोन के ऐप्स यहाँ अलग विंडो में खुलते हैं। Android के developer options इस्तेमाल होते हैं।',
    'Pairing code': 'पेयरिंग कोड', 'Pair': 'पेयर करें', 'Type the address': 'पता लिखें',
    'Apps in PC windows': 'PC की विंडो में ऐप्स', 'Open Wireless debugging': 'Wireless debugging खोलें',
    'Microphone': 'माइक्रोफ़ोन', 'phone as PC mic': 'फ़ोन बने PC का माइक', 'Use as mic': 'माइक बनाएँ',
    'Microphone for the PC': 'PC के लिए माइक्रोफ़ोन',
    'Use this phone as the PC’s microphone in calls and recordings. A notification shows whenever it’s on.': 'कॉल और रिकॉर्डिंग में इस फ़ोन को PC का माइक्रोफ़ोन बनाएँ। चालू रहने पर नोटिफ़िकेशन दिखता है।',
    'For when the Wi-Fi is slow or not there. Needs USB debugging on the phone (Android developer options).': 'जब Wi-Fi धीमा हो या न हो। फ़ोन पर USB debugging चालू होनी चाहिए (Android developer options)।',
    'Copy one-time codes by themselves': 'OTP अपने आप कॉपी करें',
    'When an OTP arrives on the phone it’s copied here, ready for Ctrl+V, and cleared again after a minute': 'फ़ोन पर OTP आते ही यहाँ कॉपी हो जाता है, Ctrl+V के लिए तैयार, और एक मिनट बाद हट जाता है',
    'Install APK': 'APK इंस्टॉल करें', 'Download adb': 'adb डाउनलोड करें', 'Auto-accept from trusted devices': 'भरोसेमंद डिवाइस से अपने आप लें',
    'Network check': 'नेटवर्क जाँच', 'Connection PIN': 'कनेक्शन PIN', 'Security code': 'सुरक्षा कोड',
    'Aurora': 'ऑरोरा', 'Frost': 'फ़्रॉस्ट', 'Petal': 'पेटल', 'Ink': 'इंक', 'Dots': 'डॉट्स',
    // ---- longer lines ----
    'Your phone shows up here with its battery, notifications and music. Everything stays on your Wi-Fi, encrypted, with no account.': 'आपका फ़ोन यहाँ अपनी बैटरी, सूचनाओं और गानों के साथ दिखता है। सब कुछ आपके Wi-Fi पर, एन्क्रिप्टेड, बिना किसी अकाउंट के।',
    'See them here, reply, copy one-time codes': 'यहाँ देखें, जवाब दें, OTP कॉपी करें',
    'Use the phone as this PC’s mouse, keyboard and remote': 'फ़ोन को इस PC का माउस, कीबोर्ड और रिमोट बनाएँ',
    'see and control it': 'देखें और चलाएँ', 'or drop them here': 'या यहाँ छोड़ें', 'send what you copied': 'कॉपी किया हुआ भेजें',
    'even on silent': 'साइलेंट पर भी', 'voice over Wi-Fi': 'Wi-Fi पर आवाज़', 'ringing now…': 'बज रहा है…',
    'Open the DropWave app on your Android phone. Its photos and videos show up here.': 'अपने Android फ़ोन पर DropWave ऐप खोलें। उसकी फ़ोटो और वीडियो यहाँ दिखेंगे।',
    'Open the DropWave app on your Android phone. Its text messages show up here.': 'अपने Android फ़ोन पर DropWave ऐप खोलें। उसके मैसेज यहाँ दिखेंगे।',
    'Open the DropWave app on your Android phone. Its contacts show up here.': 'अपने Android फ़ोन पर DropWave ऐप खोलें। उसके संपर्क यहाँ दिखेंगे।',
    'Open the DropWave app on your Android phone. Its apps show up here.': 'अपने Android फ़ोन पर DropWave ऐप खोलें। उसके ऐप्स यहाँ दिखेंगे।',
    'Open the DropWave app on your Android phone to browse its files here.': 'फ़ोन की फ़ाइलें देखने के लिए Android फ़ोन पर DropWave ऐप खोलें।',
    'No devices nearby yet. Open DropWave on another PC or connect a phone.': 'अभी आस-पास कोई डिवाइस नहीं। दूसरे PC पर DropWave खोलें या फ़ोन जोड़ें।',
    'No devices nearby yet. Open DropWave on another PC, or connect a phone.': 'अभी आस-पास कोई डिवाइस नहीं। दूसरे PC पर DropWave खोलें या फ़ोन जोड़ें।',
    'Files you send and receive will show up here.': 'भेजी और आई फ़ाइलें यहाँ दिखेंगी।', 'Files, clipboard and more will show up here.': 'फ़ाइलें, क्लिपबोर्ड और बाकी सब यहाँ दिखेगा।',
    'Send links, notes or anything on your clipboard. It stays on your network.': 'लिंक, नोट या क्लिपबोर्ड की कोई भी चीज़ भेजें। सब आपके नेटवर्क पर ही रहता है।',
    'Can’t see your other devices? Run a network check': 'दूसरे डिवाइस नहीं दिख रहे? नेटवर्क जाँच चलाएँ',
    'Find and fix why a device can’t be seen': 'पता करें और ठीक करें कि डिवाइस क्यों नहीं दिख रहा', 'Checking network, firewall and ports…': 'नेटवर्क, फ़ायरवॉल और पोर्ट जाँच रहे हैं…',
    'Connect a phone or TV': 'फ़ोन या TV जोड़ें', 'Scan this code with the camera': 'इस कोड को कैमरे से स्कैन करें',
    'Or open the address below in its browser and enter the PIN': 'या नीचे का पता उसके ब्राउज़र में खोलें और PIN डालें',
    'Connect the phone or TV to the same Wi-Fi': 'फ़ोन या TV को उसी Wi-Fi से जोड़ें', 'Works in any browser — no app needed.': 'किसी भी ब्राउज़र में चलता है — ऐप की ज़रूरत नहीं।',
    'They connect from their web browser using a QR code or PIN': 'वे QR कोड या PIN से अपने ब्राउज़र से जुड़ते हैं', 'Allow phones, tablets and TVs': 'फ़ोन, टैबलेट और TV को अनुमति दें',
    'Files from these devices are saved without asking': 'इन डिवाइस की फ़ाइलें बिना पूछे सेव होती हैं',
    'Rings the phone, even on silent': 'फ़ोन बजाता है, साइलेंट पर भी', 'See and control the phone in a window': 'फ़ोन को एक विंडो में देखें और चलाएँ',
    'Notifications, battery and music': 'सूचनाएँ, बैटरी और गाने', 'What you copied on this PC': 'इस PC पर जो कॉपी किया',
    'Lands on this PC and in the clipboard': 'इस PC पर और क्लिपबोर्ड में आती है', 'Live camera in a window, front or back': 'विंडो में लाइव कैमरा, आगे या पीछे का',
    'Copy on the phone, paste on this PC, and the other way round': 'फ़ोन पर कॉपी, इस PC पर पेस्ट, और उल्टा भी',
    'New notifications from the phone pop up here while DropWave isn’t in front': 'DropWave सामने न हो तब भी फ़ोन की नई सूचनाएँ यहाँ आती हैं',
    'The phone dials with its SIM. Talk on the phone.': 'फ़ोन अपनी SIM से कॉल करता है। बात फ़ोन पर करें।',
    'Turn on notification access on the phone': 'फ़ोन पर notification access चालू करें',
    'Only allow your own phone. You can stop it any time from Home.': 'सिर्फ़ अपने फ़ोन को अनुमति दें। होम से कभी भी रोक सकते हैं।',
    'Take back your mouse and keyboard': 'अपना माउस और कीबोर्ड वापस लें',
    'Use this if a device shows a security warning because DropWave was reinstalled on it.': 'अगर DropWave दोबारा इंस्टॉल होने से कोई डिवाइस सुरक्षा चेतावनी दिखाए तो इसका इस्तेमाल करें।',
    'This is a small preview. Download it for the full quality original.': 'यह छोटा प्रीव्यू है। पूरी क्वालिटी के लिए डाउनलोड करें।',
    'Watch it now, while it copies': 'कॉपी होते-होते अभी देखें', 'Preview before accepting': 'लेने से पहले देखें', 'Always accept from this device': 'इस डिवाइस से हमेशा लें',
    'Keep working when the phone is locked': 'फ़ोन लॉक होने पर भी काम करता रहे',
    'Android pauses apps a few minutes after the screen goes off, so the PC stops reaching this phone. Tap Allow on Android’s question. On Realme / Oppo / Vivo / Xiaomi also set App info › Battery › “Allow background activity”.':
      'स्क्रीन बंद होने के कुछ मिनट बाद Android ऐप्स को रोक देता है, फिर PC इस फ़ोन तक नहीं पहुँच पाता। Android के सवाल पर Allow दबाएँ। Realme / Oppo / Vivo / Xiaomi पर App info › Battery › “Allow background activity” भी चालू करें।',
    'Brightness from the PC: allow “Modify system settings” on the phone': 'PC से ब्राइटनेस: फ़ोन पर “Modify system settings” की अनुमति दें',
    // ---- phone screen & webcam windows ----
    'Waiting for the phone…': 'फ़ोन का इंतज़ार…', 'Starting the camera…': 'कैमरा शुरू हो रहा है…', 'Camera stopped': 'कैमरा रुक गया',
    'Couldn’t start the camera': 'कैमरा शुरू नहीं हुआ', 'DropWave Camera on': 'DropWave Camera चालू', 'Stopped': 'रुक गया',
    // ---- phone page ----
    'Chat': 'चैट', 'Privacy': 'प्राइवेसी', 'Control PC': 'PC चलाएँ', 'Deck': 'डेक', 'Send clipboard': 'क्लिपबोर्ड भेजें', 'Lock PC': 'PC लॉक करें',
    'Sleep': 'स्लीप', 'Phone on PC': 'PC पर फ़ोन', 'Look': 'लुक', 'Touchpad': 'टचपैड', 'Left click': 'लेफ़्ट क्लिक', 'Right click': 'राइट क्लिक',
    'Reconnecting…': 'फिर जोड़ रहे हैं…', 'Local network': 'लोकल नेटवर्क', 'Pause sharing': 'शेयर करना रोकें', 'Share with PC': 'PC के साथ शेयर',
    'Notifications & music': 'सूचनाएँ और गाने', 'Photos & videos': 'फ़ोटो और वीडियो', 'Calls': 'कॉल', 'Messages (SMS)': 'मैसेज (SMS)',
    'Screen on PC': 'PC पर स्क्रीन', 'Phone controls from PC': 'PC से फ़ोन कंट्रोल', 'Camera for the PC': 'PC के लिए कैमरा', 'Recent apps': 'हाल के ऐप्स',
    'Work when locked': 'लॉक होने पर भी चले', 'Turn off': 'बंद करें', 'Turn on': 'चालू करें', 'Manage': 'मैनेज करें', 'On': 'चालू', 'Off': 'बंद', 'Partly': 'आंशिक',
    'Turn off now': 'अभी बंद करें', 'Open Android’s app settings': 'Android की ऐप सेटिंग्स खोलें', 'Allow calls': 'कॉल की अनुमति दें',
    'Allow messages': 'मैसेज की अनुमति दें', 'Allow photos': 'फ़ोटो की अनुमति दें', 'App battery settings': 'ऐप बैटरी सेटिंग्स',
    'Keep working when the phone is locked': 'फ़ोन लॉक होने पर भी काम करता रहे', 'Show phone notifications on PC': 'फ़ोन की सूचनाएँ PC पर दिखाएँ',
    'Show calls on PC': 'PC पर कॉल दिखाएँ', 'Show messages on PC': 'PC पर मैसेज दिखाएँ', 'Browse phone files from PC': 'PC से फ़ोन की फ़ाइलें देखें',
    'Control this phone from PC': 'PC से इस फ़ोन को चलाएँ', 'Share photos with PC': 'PC के साथ फ़ोटो शेयर करें', 'Control from PC': 'PC से कंट्रोल',
    'switched off on the phone': 'फ़ोन पर बंद', 'Mute': 'म्यूट', 'Unmute': 'अनम्यूट', 'Speaker': 'स्पीकर', 'Speaker off': 'स्पीकर बंद', 'Silence the ringtone': 'रिंगटोन बंद करें', 'Decline with a message': 'मैसेज भेजकर काटें', 'Incoming call': 'आने वाली कॉल', 'Decline': 'काटें',
    'Recent': 'हाल के', 'Usage access settings are open': 'Usage access सेटिंग खुल गई',
    'Android pauses apps a few minutes after the screen goes off, so the PC stops reaching this phone. Tap Allow on Android’s question.': 'स्क्रीन बंद होने के कुछ मिनट बाद Android ऐप्स को रोक देता है, फिर PC इस फ़ोन तक नहीं पहुँच पाता। Android के सवाल पर Allow दबाएँ।',
    'Open Xiaomi settings': 'Xiaomi सेटिंग्स खोलें', 'Open Realme settings': 'Realme सेटिंग्स खोलें', 'Open Oppo settings': 'Oppo सेटिंग्स खोलें', 'Open Vivo settings': 'Vivo सेटिंग्स खोलें',
    'Open OnePlus settings': 'OnePlus सेटिंग्स खोलें', 'Open Samsung settings': 'Samsung सेटिंग्स खोलें', 'Open Huawei settings': 'Huawei सेटिंग्स खोलें',
    'Drop to send to': 'भेजने के लिए छोड़ें', 'Turn on': 'चालू करें', 'In the DropWave app, tap': 'DropWave ऐप में दबाएँ', 'and allow DropWave.': 'और DropWave को अनुमति दें।',
    'Android asks once; you can turn it off there any time.': 'Android एक बार पूछता है; आप वहाँ कभी भी बंद कर सकते हैं।',
  };
  // Patterns: [regex, (match) => text]
  const HI_RX = [
    [/^(\d+) switched off on the phone$/, (m) => `${m[1]} फ़ोन पर बंद`],
    [/^(\d+) apps$/, (m) => `${m[1]} ऐप्स`],
    [/^Search (\d+) contacts$/, (m) => `${m[1]} संपर्क खोजें`],
    [/^(\d+) min ago$/, (m) => `${m[1]} मिनट पहले`],
    [/^(\d+) h ago$/, (m) => `${m[1]} घंटे पहले`],
    [/^just now$/, () => 'अभी'],
    [/^(\d+)% · charging$/, (m) => `${m[1]}% · चार्ज हो रहा`],
    [/^Show (\d+) system$/, (m) => `${m[1]} सिस्टम ऐप दिखाएँ`],
    [/^Hide (\d+) system$/, (m) => `${m[1]} सिस्टम ऐप छिपाएँ`],
    [/^(.+) camera$/, (m) => `${m[1]} कैमरा`],
    [/^One more step for (.+)$/, (m) => `${m[1]} के लिए एक और कदम`],
  ];
  const DICTS = { hi: [HI, HI_RX] };

  let lang = 'en';
  const orig = new WeakMap(); // node -> English text (to switch back)
  const origAttr = new WeakMap();
  const ATTRS = ['placeholder', 'title', 'aria-label'];

  function tr(s) {
    const d = DICTS[lang];
    if (!d || !s) return null;
    const t = s.trim();
    if (!t || t.length > 200) return null;
    const hit = d[0][t];
    if (hit) return s.replace(t, hit);
    for (const [rx, f] of d[1]) { const m = t.match(rx); if (m) return s.replace(t, f(m)); }
    return null;
  }

  function doText(n) {
    const cur = n.nodeValue;
    const known = orig.get(n);
    // React (or the page) changed the text since: start from the new English.
    const en = known && known.out === cur ? known.en : cur;
    if (lang === 'en') { if (known && known.out === cur) n.nodeValue = known.en; orig.delete(n); return; }
    const out = tr(en);
    if (out != null && out !== cur) { orig.set(n, { en, out }); n.nodeValue = out; }
  }
  function doAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a);
      let map = origAttr.get(el); if (!map) { map = {}; origAttr.set(el, map); }
      const k = map[a];
      const en = k && k.out === cur ? k.en : cur;
      if (lang === 'en') { if (k && k.out === cur) el.setAttribute(a, k.en); delete map[a]; continue; }
      const out = tr(en);
      if (out != null && out !== cur) { map[a] = { en, out }; el.setAttribute(a, out); }
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1) return;
    if (root.closest && root.closest('input, textarea, [contenteditable], [data-no-translate]')) return;
    doAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === 1 && /^(SCRIPT|STYLE|TEXTAREA|INPUT)$/.test(n.nodeName)) || (n.nodeType === 1 && n.hasAttribute('data-no-translate')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  let obs = null;
  let busy = false;
  function start() {
    if (obs || !document.body) return;
    obs = new MutationObserver((list) => {
      if (busy) return;
      busy = true;
      try {
        for (const m of list) {
          if (m.type === 'characterData') doText(m.target);
          else if (m.type === 'attributes') doAttrs(m.target);
          else m.addedNodes.forEach(walk);
        }
      } finally { busy = false; }
    });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  window.DWTranslate = {
    get: () => lang,
    set(l) {
      lang = DICTS[l] ? l : 'en';
      document.documentElement.lang = lang;
      const go = () => { start(); busy = true; try { walk(document.body); } finally { busy = false; } };
      if (document.body) go(); else document.addEventListener('DOMContentLoaded', go, { once: true });
    },
  };
})();
