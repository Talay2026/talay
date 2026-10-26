// Talay booking page: talay.io/b/[center-slug] (optional ?p=[product-code], several p= for several bookings)
// Reads the center and product from Airtable (read-only token) and renders a
// white-label page: the diver sees the dive center; Talay only appears in the fine print and on Stripe.
// Everything outside /b/ is served from /public by the assets binding.
//
// Languages: English, French, German, Spanish, Dutch. The page follows ?l=fr|de|es|nl|en
// if present, otherwise the language of the diver's phone or browser. The diver can switch in the menu at the top.
// Optional Airtable fields per language (fallback to English when empty):
//   Products: "Name FR", "Duration FR", "Included FR", "Check-in FR" (also DE, ES, NL)
//   Centers:  "Meeting point FR" (also DE, ES, NL)

import { handleZone, runHqAlerts, runOutreachSync, handlePush, handleWeekly } from "./zone.js"; // customer zone for dive centers: talay.io/zone (+ alerts for Talay HQ)
import { handleDemo } from "./demo.js"; // demo requests from the homepage form: talay.io/api/demo
import { handleIntake } from "./intake.js"; // onboarding form for a new centre: talay.io/start -> talay.io/api/intake
import { handleNotify } from "./notify.js"; // WhatsApp and push to dive center staff, called by Make: talay.io/api/notify

const CACHE_SECONDS = 120; // limits Airtable API calls; logo links stay valid
const MAX_DIVERS = 10; // more than 10 goes to a person (rule from the conversation flow)
const LANGS = ["en", "fr", "de", "es", "nl"];
const LOCALES = { en: "en-GB", fr: "fr-FR", de: "de-DE", es: "es-ES", nl: "nl-BE" };

// ---------- Texts ----------

const T = {
  en: {
    title: "Book your dive",
    testmode: "Test mode: no real payment is taken.",
    includes: "Includes",
    startDate: "Start date",
    date: "Date",
    earliest: (d) => `Earliest date you can still book online: ${d}.`,
    diversLabel: "Number of divers",
    less: "One diver less",
    more: "One diver more",
    group: (a) => `Coming with more than ${MAX_DIVERS}? Message ${a} in your chat and the team will plan it with you.`,
    diver: "diver", divers: "divers",
    totalFor: "Total for",
    payNow: "Pay now to secure your spot",
    payShop: "Pay at the shop on the day",
    never: "You never pay more than the shop price.",
    terms: ["Booking and payment via Talay. ", "Booking terms"],
    termsStripe: "By paying you accept the [booking terms](https://talay.io/terms/).",
    btn: ["Pay ", " THB and book"],
    checkIn: "Check-in",
    meeting: "Meeting point",
    chooseDate: "Choose a date first.",
    tooSoon: (m) => `That date is too soon to book online. Choose ${m} or later.`,
    tooFar: (a) => `That date is too far ahead to book online. Message ${a} in your chat.`,
    noPay: (a) => `Online payment opens soon. For now, reply to ${a} in your chat with your date and number of divers, and the team will book you in.`,
    opening: "Opening secure payment…",
    wrong: "Something went wrong. Try again.",
    noConn: "No connection. Check your internet and try again.",
    notAvailable: "Online payment is not available yet.",
    invalid: "Invalid request.",
    chooseFrom: (m) => `Choose ${m} or later.`,
    chooseDivers: `Choose between 1 and ${MAX_DIVERS} divers.`,
    deposit: (n, c) => `Deposit: ${n} at ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. You pay the remaining ${b} THB at the shop.`,
    booked: "You're booked",
    paidNow: "Paid now",
    change: "If the team needs to change your booking, they'll message you within two hours.",
    questions: (a) => `Questions? Reply to ${a} in your chat.`,
    policyTitle: "Good to know",
    policy: [
      "Free to move to another date within 6 months.",
      "If you cancel, your deposit stays valid for another date within 6 months.",
      "If the dive centre cancels or the weather stops the dive and no new date works, you get your deposit back.",
    ],
    secure: "Secure payment by Stripe.",
    backToChat: "Back to the chat",
    askFirst: (a) => `Questions first? Message ${a}.`,
    nextTitle: "Before you come",
    courseNote: "For a course, there is usually a short welcome and paperwork at the shop before the first lesson. The team confirms the time in the chat.",
    bring: "What to bring",
    bringText: "Swimwear, a towel, sun cream and your passport or ID. Certified divers: your certification card (or the app) and logbook.",
    map: "Open in Google Maps",
    notPaid: "We haven't received your payment. Open the booking link again to try once more.",
    notFoundTitle: "This booking link doesn't work",
    notFoundText: "Open the link again from your chat with the dive center, or send them a message and they'll send a new one.",
    problemTitle: "Booking page unavailable",
    missingKey: "The booking page is not set up yet (missing key).",
    loadFail: "We couldn't load this booking right now. Try again in a minute.",
  },
  fr: {
    title: "Réservez votre plongée",
    testmode: "Mode test : aucun paiement réel n'est effectué.",
    includes: "Inclus :",
    startDate: "Date de début",
    date: "Date",
    earliest: (d) => `Première date encore réservable en ligne : ${d}.`,
    diversLabel: "Nombre de plongeurs",
    less: "Un plongeur de moins",
    more: "Un plongeur de plus",
    group: (a) => `Vous êtes plus de ${MAX_DIVERS} ? Écrivez à ${a} dans votre conversation et l'équipe organisera tout avec vous.`,
    diver: "plongeur", divers: "plongeurs",
    totalFor: "Total pour",
    payNow: "À payer maintenant pour réserver votre place",
    payShop: "À payer au centre le jour même",
    never: "Vous ne payez jamais plus que le prix du centre.",
    terms: ["Réservation et paiement via Talay. ", "Conditions de réservation"],
    termsStripe: "En payant, vous acceptez les [conditions de réservation](https://talay.io/terms/fr/).",
    btn: ["Payer ", " THB et réserver"],
    checkIn: "Check-in",
    meeting: "Point de rendez-vous",
    chooseDate: "Choisissez d'abord une date.",
    tooSoon: (m) => `Cette date est trop proche pour réserver en ligne. Choisissez le ${m} ou plus tard.`,
    tooFar: (a) => `Cette date est trop lointaine pour réserver en ligne. Écrivez à ${a} dans votre conversation.`,
    noPay: (a) => `Le paiement en ligne arrive bientôt. En attendant, envoyez à ${a} dans votre conversation votre date et le nombre de plongeurs, et l'équipe s'occupe de votre réservation.`,
    opening: "Ouverture du paiement sécurisé…",
    wrong: "Une erreur s'est produite. Réessayez.",
    noConn: "Pas de connexion. Vérifiez votre connexion internet et réessayez.",
    notAvailable: "Le paiement en ligne n'est pas encore disponible.",
    invalid: "Demande non valide.",
    chooseFrom: (m) => `Choisissez le ${m} ou plus tard.`,
    chooseDivers: `Choisissez entre 1 et ${MAX_DIVERS} plongeurs.`,
    deposit: (n, c) => `Acompte : ${n} chez ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. Vous payez le solde de ${b} THB au centre.`,
    booked: "Votre réservation est confirmée",
    paidNow: "Payé maintenant",
    change: "Si l'équipe doit modifier votre réservation, elle vous écrira dans les deux heures.",
    questions: (a) => `Des questions ? Répondez à ${a} dans votre conversation.`,
    policyTitle: "Bon à savoir",
    policy: [
      "Changement de date gratuit dans les 6 mois.",
      "Si vous annulez, votre acompte reste valable pour une autre date dans les 6 mois.",
      "Si le centre annule ou si la météo empêche la plongée et qu'aucune autre date ne convient, votre acompte vous est remboursé.",
    ],
    secure: "Paiement sécurisé par Stripe.",
    backToChat: "Retour à la conversation",
    askFirst: (a) => `Une question avant ? Écrivez à ${a}.`,
    nextTitle: "Avant de venir",
    courseNote: "Pour un cours, il y a en général un court accueil et quelques formalités au centre avant la première leçon. L'équipe vous confirme l'heure dans la conversation.",
    bring: "À apporter",
    bringText: "Maillot de bain, serviette, crème solaire et passeport ou pièce d'identité. Plongeurs certifiés : votre carte de certification (ou l'appli) et votre carnet de plongée.",
    map: "Ouvrir dans Google Maps",
    notPaid: "Nous n'avons pas reçu votre paiement. Ouvrez à nouveau le lien de réservation pour réessayer.",
    notFoundTitle: "Ce lien de réservation ne fonctionne pas",
    notFoundText: "Ouvrez à nouveau le lien depuis votre conversation avec le centre de plongée, ou envoyez-leur un message et ils vous enverront un nouveau lien.",
    problemTitle: "Page de réservation indisponible",
    missingKey: "La page de réservation n'est pas encore configurée (clé manquante).",
    loadFail: "Impossible de charger cette réservation pour le moment. Réessayez dans une minute.",
  },
  de: {
    title: "Buche deinen Tauchgang",
    testmode: "Testmodus: Es wird keine echte Zahlung abgebucht.",
    includes: "Inklusive",
    startDate: "Startdatum",
    date: "Datum",
    earliest: (d) => `Frühestes Datum, das du noch online buchen kannst: ${d}.`,
    diversLabel: "Anzahl Taucher",
    less: "Ein Taucher weniger",
    more: "Ein Taucher mehr",
    group: (a) => `Ihr seid mehr als ${MAX_DIVERS}? Schreib ${a} im Chat, dann plant das Team alles mit euch.`,
    diver: "Taucher", divers: "Taucher",
    totalFor: "Gesamt für",
    payNow: "Jetzt zahlen und Platz sichern",
    payShop: "Am Tag selbst im Shop zahlen",
    never: "Du zahlst nie mehr als den Preis im Shop.",
    terms: ["Buchung und Zahlung über Talay. ", "Buchungsbedingungen"],
    termsStripe: "Mit der Zahlung akzeptierst du die [Buchungsbedingungen](https://talay.io/terms/de/).",
    btn: ["", " THB zahlen und buchen"],
    checkIn: "Check-in",
    meeting: "Treffpunkt",
    chooseDate: "Wähle zuerst ein Datum.",
    tooSoon: (m) => `Dieses Datum ist zu früh für eine Online-Buchung. Wähle ${m} oder später.`,
    tooFar: (a) => `Dieses Datum liegt zu weit in der Zukunft für eine Online-Buchung. Schreib ${a} im Chat.`,
    noPay: (a) => `Online-Zahlung kommt bald. Schick ${a} bis dahin im Chat dein Datum und die Anzahl Taucher, dann bucht das Team für dich.`,
    opening: "Sichere Zahlung wird geöffnet…",
    wrong: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
    noConn: "Keine Verbindung. Prüfe dein Internet und versuch es noch einmal.",
    notAvailable: "Online-Zahlung ist noch nicht verfügbar.",
    invalid: "Ungültige Anfrage.",
    chooseFrom: (m) => `Wähle ${m} oder später.`,
    chooseDivers: `Wähle zwischen 1 und ${MAX_DIVERS} Tauchern.`,
    deposit: (n, c) => `Anzahlung: ${n} bei ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. Den Rest von ${b} THB zahlst du im Shop.`,
    booked: "Du bist gebucht",
    paidNow: "Jetzt bezahlt",
    change: "Falls das Team deine Buchung ändern muss, meldet es sich innerhalb von zwei Stunden bei dir.",
    questions: (a) => `Fragen? Antworte ${a} im Chat.`,
    policyTitle: "Gut zu wissen",
    policy: [
      "Kostenlos auf ein anderes Datum innerhalb von 6 Monaten verschieben.",
      "Wenn du stornierst, bleibt deine Anzahlung 6 Monate lang für ein anderes Datum gültig.",
      "Sagt das Tauchcenter ab oder verhindert das Wetter den Tauchgang und passt kein neues Datum, bekommst du die Anzahlung zurück.",
    ],
    secure: "Sichere Zahlung über Stripe.",
    backToChat: "Zurück zum Chat",
    askFirst: (a) => `Vorher noch Fragen? Schreib ${a}.`,
    nextTitle: "Bevor du kommst",
    courseNote: "Bei einem Kurs gibt es meist vor der ersten Lektion eine kurze Begrüßung und Formalitäten im Shop. Das Team bestätigt dir die Uhrzeit im Chat.",
    bring: "Mitbringen",
    bringText: "Badesachen, Handtuch, Sonnencreme und Reisepass oder Ausweis. Zertifizierte Taucher: Brevet (oder App) und Logbuch.",
    map: "In Google Maps öffnen",
    notPaid: "Wir haben deine Zahlung nicht erhalten. Öffne den Buchungslink noch einmal, um es erneut zu versuchen.",
    notFoundTitle: "Dieser Buchungslink funktioniert nicht",
    notFoundText: "Öffne den Link noch einmal aus deinem Chat mit der Tauchbasis, oder schreib ihnen, dann bekommst du einen neuen Link.",
    problemTitle: "Buchungsseite nicht verfügbar",
    missingKey: "Die Buchungsseite ist noch nicht eingerichtet (Schlüssel fehlt).",
    loadFail: "Diese Buchung kann gerade nicht geladen werden. Versuch es in einer Minute noch einmal.",
  },
  es: {
    title: "Reserva tu inmersión",
    testmode: "Modo de prueba: no se realiza ningún pago real.",
    includes: "Incluye",
    startDate: "Fecha de inicio",
    date: "Fecha",
    earliest: (d) => `Primera fecha que aún puedes reservar online: ${d}.`,
    diversLabel: "Número de buceadores",
    less: "Un buceador menos",
    more: "Un buceador más",
    group: (a) => `¿Sois más de ${MAX_DIVERS}? Escribe a ${a} en el chat y el equipo lo organizará con vosotros.`,
    diver: "buceador", divers: "buceadores",
    totalFor: "Total para",
    payNow: "Paga ahora para asegurar tu plaza",
    payShop: "Paga en el centro el mismo día",
    never: "Nunca pagas más que el precio del centro.",
    terms: ["Reserva y pago a través de Talay. ", "Condiciones de reserva"],
    termsStripe: "Al pagar aceptas las [condiciones de reserva](https://talay.io/terms/es/).",
    btn: ["Pagar ", " THB y reservar"],
    checkIn: "Check-in",
    meeting: "Punto de encuentro",
    chooseDate: "Elige primero una fecha.",
    tooSoon: (m) => `Esa fecha es demasiado pronto para reservar online. Elige el ${m} o una fecha posterior.`,
    tooFar: (a) => `Esa fecha está demasiado lejos para reservar online. Escribe a ${a} en el chat.`,
    noPay: (a) => `El pago online llegará pronto. Mientras tanto, envía a ${a} en el chat tu fecha y el número de buceadores, y el equipo te hará la reserva.`,
    opening: "Abriendo el pago seguro…",
    wrong: "Algo salió mal. Inténtalo de nuevo.",
    noConn: "Sin conexión. Revisa tu internet e inténtalo de nuevo.",
    notAvailable: "El pago online aún no está disponible.",
    invalid: "Solicitud no válida.",
    chooseFrom: (m) => `Elige el ${m} o una fecha posterior.`,
    chooseDivers: `Elige entre 1 y ${MAX_DIVERS} buceadores.`,
    deposit: (n, c) => `Depósito: ${n} en ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. El resto, ${b} THB, lo pagas en el centro.`,
    booked: "Tu reserva está confirmada",
    paidNow: "Pagado ahora",
    change: "Si el equipo necesita cambiar tu reserva, te escribirá en un plazo de dos horas.",
    questions: (a) => `¿Preguntas? Responde a ${a} en el chat.`,
    policyTitle: "Bueno saber",
    policy: [
      "Cambio de fecha gratis dentro de 6 meses.",
      "Si cancelas, tu depósito sigue siendo válido para otra fecha dentro de 6 meses.",
      "Si el centro cancela o el tiempo impide la inmersión y no hay otra fecha posible, te devolvemos el depósito.",
    ],
    secure: "Pago seguro con Stripe.",
    backToChat: "Volver al chat",
    askFirst: (a) => `¿Preguntas antes? Escribe a ${a}.`,
    nextTitle: "Antes de venir",
    courseNote: "En un curso suele haber una breve bienvenida y papeleo en el centro antes de la primera clase. El equipo te confirma la hora en el chat.",
    bring: "Qué traer",
    bringText: "Bañador, toalla, crema solar y pasaporte o documento de identidad. Buceadores certificados: tu tarjeta de certificación (o la app) y tu logbook.",
    map: "Abrir en Google Maps",
    notPaid: "No hemos recibido tu pago. Abre de nuevo el enlace de reserva para volver a intentarlo.",
    notFoundTitle: "Este enlace de reserva no funciona",
    notFoundText: "Abre de nuevo el enlace desde tu chat con el centro de buceo, o escríbeles y te enviarán uno nuevo.",
    problemTitle: "Página de reserva no disponible",
    missingKey: "La página de reserva aún no está configurada (falta la clave).",
    loadFail: "No hemos podido cargar esta reserva ahora mismo. Inténtalo de nuevo en un minuto.",
  },
  nl: {
    title: "Boek je duik",
    testmode: "Testmodus: er wordt geen echte betaling uitgevoerd.",
    includes: "Inbegrepen:",
    startDate: "Startdatum",
    date: "Datum",
    earliest: (d) => `Vroegste datum die je nog online kan boeken: ${d}.`,
    diversLabel: "Aantal duikers",
    less: "Eén duiker minder",
    more: "Eén duiker meer",
    group: (a) => `Met meer dan ${MAX_DIVERS}? Stuur ${a} een bericht in je chat, dan plant het team alles met jullie.`,
    diver: "duiker", divers: "duikers",
    totalFor: "Totaal voor",
    payNow: "Nu betalen om je plaats vast te leggen",
    payShop: "Op de dag zelf te betalen in het duikcentrum",
    never: "Je betaalt nooit meer dan de prijs in het duikcentrum.",
    terms: ["Boeking en betaling via Talay. ", "Boekingsvoorwaarden"],
    termsStripe: "Door te betalen aanvaard je de [boekingsvoorwaarden](https://talay.io/terms/nl/).",
    btn: ["Betaal ", " THB en boek"],
    checkIn: "Check-in",
    meeting: "Afspraakpunt",
    chooseDate: "Kies eerst een datum.",
    tooSoon: (m) => `Die datum is te vroeg om online te boeken. Kies ${m} of later.`,
    tooFar: (a) => `Die datum ligt te ver vooruit om online te boeken. Stuur ${a} een bericht in je chat.`,
    noPay: (a) => `Online betalen komt binnenkort. Stuur ${a} intussen in je chat je datum en het aantal duikers, dan boekt het team je in.`,
    opening: "Beveiligde betaling wordt geopend…",
    wrong: "Er ging iets mis. Probeer het opnieuw.",
    noConn: "Geen verbinding. Controleer je internet en probeer het opnieuw.",
    notAvailable: "Online betalen is nog niet beschikbaar.",
    invalid: "Ongeldige aanvraag.",
    chooseFrom: (m) => `Kies ${m} of later.`,
    chooseDivers: `Kies tussen 1 en ${MAX_DIVERS} duikers.`,
    deposit: (n, c) => `Voorschot: ${n} bij ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. De rest, ${b} THB, betaal je in het duikcentrum.`,
    booked: "Je boeking staat vast",
    paidNow: "Nu betaald",
    change: "Moet het team je boeking aanpassen, dan stuurt het je binnen twee uur een bericht.",
    questions: (a) => `Vragen? Antwoord ${a} in je chat.`,
    policyTitle: "Goed om te weten",
    policy: [
      "Gratis verplaatsen naar een andere datum binnen 6 maanden.",
      "Annuleer je, dan blijft je voorschot 6 maanden geldig voor een andere datum.",
      "Annuleert het duikcentrum of houdt het weer de duik tegen en past geen nieuwe datum, dan krijg je je voorschot terug.",
    ],
    secure: "Veilig betalen via Stripe.",
    backToChat: "Terug naar de chat",
    askFirst: (a) => `Eerst nog een vraag? Stuur ${a} een bericht.`,
    nextTitle: "Voor je komt",
    courseNote: "Bij een cursus is er meestal een korte ontvangst en wat papierwerk in de shop voor de eerste les. Het team bevestigt het uur in de chat.",
    bring: "Meebrengen",
    bringText: "Zwemkleding, een handdoek, zonnecrème en je paspoort of identiteitskaart. Gebrevetteerde duikers: je brevet (of de app) en je logboek.",
    map: "Openen in Google Maps",
    notPaid: "We hebben je betaling niet ontvangen. Open de boekingslink opnieuw om het nog eens te proberen.",
    notFoundTitle: "Deze boekingslink werkt niet",
    notFoundText: "Open de link opnieuw vanuit je gesprek met het duikcentrum, of stuur hen een bericht, dan krijg je een nieuwe link.",
    problemTitle: "Boekingspagina niet beschikbaar",
    missingKey: "De boekingspagina is nog niet ingesteld (sleutel ontbreekt).",
    loadFail: "We konden deze boeking nu niet laden. Probeer het over een minuut opnieuw.",
  },
};

// Texts of the booking page with several bookings under each other (added 25 Oct, merged into T below).
const T_BOOK = {
  en: {
    pageTitle: "Book your diving",
    via: "Secure booking via Talay",
    reviews: (n) => `${n} Google reviews`,
    activity: "What would you like to do?",
    groups: { new: ["New to diving", "Try it or get your first certificate"], cert: ["Certified", "Fun dives and a refresh"], up: ["Level up", "Your next course"] },
    refreshTip: "Last dive more than a year ago? Start with a Refresh.",
    clash: (d, a) => `On ${d} you already have ${a}. That's fine if it's for someone else; otherwise choose another day.`,
    prevWeek: "Previous week", nextWeek: "Next week",
    bookingNo: "Booking number",
    choosePrice: "Choose an activity above to see the price.",
    perDiver: "per diver",
    infoTitle: "What's included",
    dives: (n) => `${n} dives`,
    infoDives: "Dives", infoDepth: "Max depth", infoDuration: "Duration", infoFor: "For", infoInc: "Included", infoNot: "Not included", infoBring: "Bring",
    minAge: (n) => `from ${n} years`,
    groupNote: "You'll probably dive in more than one group; we'll try to put you on the same boat.",
    slotLabel: "Morning or afternoon",
    amS: "AM", pmS: "PM", am: "Morning", pm: "Afternoon", day: "Full day",
    days: (n) => `${n} days`,
    chooseActivity: "Choose an activity first.",
    chooseSlot: "Choose morning or afternoon.",
    notOpen: "This day is not available.",
    dayFull: "This day is fully booked. Choose another day.",
    slotFull: "full",
    done: "Done", edit: "Change", remove: "Remove",
    another: "Book another one",
    bookingN: (n) => `Booking ${n}`,
    depositWord: "deposit",
    overview: "Your plan",
    overviewEmpty: "Your bookings show up here.",
    overlap: (d) => `${d}: these bookings overlap. That's fine if they're for different divers; otherwise choose another day.`,
    noteLabel: "Anything we should know?",
    notePh: "For example: we dive together with Anna and Tom.",
    totalAll: "Total",
    unknown: (n) => `${n} can't be booked online right now. Choose another activity or ask in the chat.`,
    prevMonth: "Previous month", nextMonth: "Next month",
    fixFirst: "Finish the booking marked in red first.",
    tooMany: "You can book up to 8 activities at once.",
    confirmHi: (n) => `Hi ${n}, you're booked! ✅`,
    confirmHiNo: "You're booked! ✅",
    confirmPaid: (x) => `Paid now: ${x} THB`,
    confirmShop: (x) => `At the shop: ${x} THB`,
    confirmEnd: "Questions? Just reply here.",
  },
  fr: {
    pageTitle: "Réservez vos plongées",
    via: "Réservation sécurisée via Talay",
    reviews: (n) => `${n} avis Google`,
    activity: "Que souhaitez-vous faire ?",
    groups: { new: ["Jamais plongé", "Essayer ou passer un premier niveau"], cert: ["Je suis certifié", "Plongées loisir et remise à niveau"], up: ["Progresser", "Votre prochaine formation"] },
    refreshTip: "Dernière plongée il y a plus d'un an ? Commencez par un Refresh.",
    clash: (d, a) => `Le ${d}, vous avez déjà ${a}. Pas de souci si c'est pour quelqu'un d'autre ; sinon, choisissez un autre jour.`,
    prevWeek: "Semaine précédente", nextWeek: "Semaine suivante",
    bookingNo: "Numéro de réservation",
    choosePrice: "Choisissez une activité ci-dessus pour voir le prix.",
    perDiver: "par plongeur",
    infoTitle: "Ce qui est inclus",
    dives: (n) => `${n} plongées`,
    infoDives: "Plongées", infoDepth: "Profondeur max.", infoDuration: "Durée", infoFor: "Pour", infoInc: "Inclus", infoNot: "Non inclus", infoBring: "À apporter",
    minAge: (n) => `à partir de ${n} ans`,
    groupNote: "Vous plongerez probablement en plusieurs groupes ; nous essaierons de vous mettre sur le même bateau.",
    slotLabel: "Matin ou après-midi",
    amS: "mat.", pmS: "ap.-m.", am: "Matin", pm: "Après-midi", day: "Journée entière",
    days: (n) => `${n} jours`,
    chooseActivity: "Choisissez d'abord une activité.",
    chooseSlot: "Choisissez le matin ou l'après-midi.",
    notOpen: "Ce jour n'est pas disponible.",
    dayFull: "Ce jour est complet. Choisissez un autre jour.",
    slotFull: "complet",
    done: "Valider", edit: "Modifier", remove: "Supprimer",
    another: "Réserver autre chose",
    bookingN: (n) => `Réservation ${n}`,
    depositWord: "acompte",
    overview: "Votre programme",
    overviewEmpty: "Vos réservations apparaissent ici.",
    overlap: (d) => `${d} : ces réservations se chevauchent. Pas de souci si ce sont d'autres plongeurs ; sinon choisissez un autre jour.`,
    noteLabel: "Quelque chose à nous dire ?",
    notePh: "Par exemple : nous plongeons avec Anna et Tom.",
    totalAll: "Total",
    unknown: (n) => `${n} ne peut pas être réservé en ligne pour le moment. Choisissez une autre activité ou demandez dans la conversation.`,
    prevMonth: "Mois précédent", nextMonth: "Mois suivant",
    fixFirst: "Terminez d'abord la réservation marquée en rouge.",
    tooMany: "Vous pouvez réserver jusqu'à 8 activités à la fois.",
    confirmHi: (n) => `Bonjour ${n}, c'est réservé ! ✅`,
    confirmHiNo: "C'est réservé ! ✅",
    confirmPaid: (x) => `Payé maintenant : ${x} THB`,
    confirmShop: (x) => `Au centre : ${x} THB`,
    confirmEnd: "Des questions ? Répondez simplement ici.",
  },
  de: {
    pageTitle: "Buche deine Tauchgänge",
    via: "Sichere Buchung über Talay",
    reviews: (n) => `${n} Google-Bewertungen`,
    activity: "Was möchtest du machen?",
    groups: { new: ["Noch nie getaucht", "Ausprobieren oder ersten Tauchschein machen"], cert: ["Ich habe einen Tauchschein", "Fun Dives und Auffrischung"], up: ["Weiterlernen", "Dein nächster Kurs"] },
    refreshTip: "Letzter Tauchgang vor mehr als einem Jahr? Beginne mit einem Refresh.",
    clash: (d, a) => `Am ${d} hast du schon ${a}. Kein Problem, wenn es für jemand anderen ist; sonst wähle einen anderen Tag.`,
    prevWeek: "Vorherige Woche", nextWeek: "Nächste Woche",
    bookingNo: "Buchungsnummer",
    choosePrice: "Wähle oben eine Aktivität, um den Preis zu sehen.",
    perDiver: "pro Taucher",
    infoTitle: "Was inklusive ist",
    dives: (n) => `${n} Tauchgänge`,
    infoDives: "Tauchgänge", infoDepth: "Max. Tiefe", infoDuration: "Dauer", infoFor: "Für", infoInc: "Inklusive", infoNot: "Nicht inklusive", infoBring: "Mitbringen",
    minAge: (n) => `ab ${n} Jahren`,
    groupNote: "Ihr taucht wahrscheinlich in mehreren Gruppen; wir versuchen, euch auf dasselbe Boot zu setzen.",
    slotLabel: "Vormittag oder Nachmittag",
    amS: "Vorm.", pmS: "Nachm.", am: "Vormittag", pm: "Nachmittag", day: "Ganzer Tag",
    days: (n) => `${n} Tage`,
    chooseActivity: "Wähle zuerst eine Aktivität.",
    chooseSlot: "Wähle Vormittag oder Nachmittag.",
    notOpen: "Dieser Tag ist nicht verfügbar.",
    dayFull: "Dieser Tag ist ausgebucht. Wähle einen anderen Tag.",
    slotFull: "ausgebucht",
    done: "Fertig", edit: "Ändern", remove: "Entfernen",
    another: "Noch etwas buchen",
    bookingN: (n) => `Buchung ${n}`,
    depositWord: "Anzahlung",
    overview: "Dein Plan",
    overviewEmpty: "Deine Buchungen erscheinen hier.",
    overlap: (d) => `${d}: Diese Buchungen überschneiden sich. Kein Problem, wenn es andere Taucher sind; sonst wähle einen anderen Tag.`,
    noteLabel: "Sollen wir noch etwas wissen?",
    notePh: "Zum Beispiel: Wir tauchen zusammen mit Anna und Tom.",
    totalAll: "Gesamt",
    unknown: (n) => `${n} kann gerade nicht online gebucht werden. Wähle eine andere Aktivität oder frag im Chat.`,
    prevMonth: "Vorheriger Monat", nextMonth: "Nächster Monat",
    fixFirst: "Schließe zuerst die rot markierte Buchung ab.",
    tooMany: "Du kannst bis zu 8 Aktivitäten auf einmal buchen.",
    confirmHi: (n) => `Hallo ${n}, du bist gebucht! ✅`,
    confirmHiNo: "Du bist gebucht! ✅",
    confirmPaid: (x) => `Jetzt bezahlt: ${x} THB`,
    confirmShop: (x) => `Im Shop: ${x} THB`,
    confirmEnd: "Fragen? Antworte einfach hier.",
  },
  es: {
    pageTitle: "Reserva tus inmersiones",
    via: "Reserva segura a través de Talay",
    reviews: (n) => `${n} reseñas de Google`,
    activity: "¿Qué te gustaría hacer?",
    groups: { new: ["Nunca he buceado", "Pruébalo o saca tu primera titulación"], cert: ["Tengo titulación", "Fun dives y repaso"], up: ["Seguir aprendiendo", "Tu próximo curso"] },
    refreshTip: "¿Tu última inmersión fue hace más de un año? Empieza con un Refresh.",
    clash: (d, a) => `El ${d} ya tienes ${a}. No pasa nada si es para otra persona; si no, elige otro día.`,
    prevWeek: "Semana anterior", nextWeek: "Semana siguiente",
    bookingNo: "Número de reserva",
    choosePrice: "Elige una actividad arriba para ver el precio.",
    perDiver: "por buceador",
    infoTitle: "Qué incluye",
    dives: (n) => `${n} inmersiones`,
    infoDives: "Inmersiones", infoDepth: "Profundidad máx.", infoDuration: "Duración", infoFor: "Para", infoInc: "Incluye", infoNot: "No incluye", infoBring: "Trae",
    minAge: (n) => `desde ${n} años`,
    groupNote: "Probablemente buceéis en más de un grupo; intentaremos poneros en el mismo barco.",
    slotLabel: "Mañana o tarde",
    amS: "mañ.", pmS: "tarde", am: "Mañana", pm: "Tarde", day: "Día completo",
    days: (n) => `${n} días`,
    chooseActivity: "Elige primero una actividad.",
    chooseSlot: "Elige mañana o tarde.",
    notOpen: "Este día no está disponible.",
    dayFull: "Este día está completo. Elige otro día.",
    slotFull: "completo",
    done: "Listo", edit: "Cambiar", remove: "Quitar",
    another: "Reservar otra cosa",
    bookingN: (n) => `Reserva ${n}`,
    depositWord: "depósito",
    overview: "Tu plan",
    overviewEmpty: "Tus reservas aparecen aquí.",
    overlap: (d) => `${d}: estas reservas se solapan. No pasa nada si son buceadores distintos; si no, elige otro día.`,
    noteLabel: "¿Algo que debamos saber?",
    notePh: "Por ejemplo: buceamos junto con Anna y Tom.",
    totalAll: "Total",
    unknown: (n) => `${n} no se puede reservar online ahora mismo. Elige otra actividad o pregunta en el chat.`,
    prevMonth: "Mes anterior", nextMonth: "Mes siguiente",
    fixFirst: "Termina primero la reserva marcada en rojo.",
    tooMany: "Puedes reservar hasta 8 actividades a la vez.",
    confirmHi: (n) => `¡Hola ${n}, ya tienes tu reserva! ✅`,
    confirmHiNo: "¡Ya tienes tu reserva! ✅",
    confirmPaid: (x) => `Pagado ahora: ${x} THB`,
    confirmShop: (x) => `En la tienda: ${x} THB`,
    confirmEnd: "¿Preguntas? Responde aquí.",
  },
  nl: {
    pageTitle: "Boek je duiken",
    via: "Veilig boeken via Talay",
    reviews: (n) => `${n} Google-reviews`,
    activity: "Wat wil je doen?",
    groups: { new: ["Nog nooit gedoken", "Probeer het of haal je eerste brevet"], cert: ["Ik heb een brevet", "Duiktrips en een opfrisduik"], up: ["Verder leren", "Je volgende opleiding"] },
    refreshTip: "Laatste duik meer dan een jaar geleden? Begin met een Refresh.",
    clash: (d, a) => `Op ${d} heb je al ${a}. Geen probleem als dit voor iemand anders is; anders kies je een andere dag.`,
    prevWeek: "Vorige week", nextWeek: "Volgende week",
    bookingNo: "Boekingsnummer",
    choosePrice: "Kies hierboven een activiteit om de prijs te zien.",
    perDiver: "per duiker",
    infoTitle: "Wat is inbegrepen",
    dives: (n) => `${n} duiken`,
    infoDives: "Duiken", infoDepth: "Max. diepte", infoDuration: "Duur", infoFor: "Voor", infoInc: "Inbegrepen", infoNot: "Niet inbegrepen", infoBring: "Meebrengen",
    minAge: (n) => `vanaf ${n} jaar`,
    groupNote: "Jullie duiken waarschijnlijk in meerdere groepen; we proberen jullie wel op dezelfde boot te zetten.",
    slotLabel: "Voormiddag of namiddag",
    amS: "VM", pmS: "NM", am: "Voormiddag", pm: "Namiddag", day: "Hele dag",
    days: (n) => `${n} dagen`,
    chooseActivity: "Kies eerst een activiteit.",
    chooseSlot: "Kies voormiddag of namiddag.",
    notOpen: "Deze dag is niet beschikbaar.",
    dayFull: "Deze dag is volgeboekt. Kies een andere dag.",
    slotFull: "vol",
    done: "Klaar", edit: "Aanpassen", remove: "Verwijderen",
    another: "Nog iets boeken",
    bookingN: (n) => `Boeking ${n}`,
    depositWord: "voorschot",
    overview: "Jouw planning",
    overviewEmpty: "Je boekingen verschijnen hier.",
    overlap: (d) => `${d}: deze boekingen overlappen. Geen probleem als het andere duikers zijn; anders kies je een andere dag.`,
    noteLabel: "Iets wat we moeten weten?",
    notePh: "Bijvoorbeeld: we duiken samen met Anna en Tom.",
    totalAll: "Totaal",
    unknown: (n) => `${n} kan nu niet online geboekt worden. Kies een andere activiteit of vraag het in de chat.`,
    prevMonth: "Vorige maand", nextMonth: "Volgende maand",
    fixFirst: "Werk eerst de rood gemarkeerde boeking af.",
    tooMany: "Je kunt tot 8 activiteiten tegelijk boeken.",
    confirmHi: (n) => `Hoi ${n}, je bent geboekt! ✅`,
    confirmHiNo: "Je bent geboekt! ✅",
    confirmPaid: (x) => `Nu betaald: ${x} THB`,
    confirmShop: (x) => `In de shop: ${x} THB`,
    confirmEnd: "Vragen? Antwoord gewoon hier.",
  },
};
for (const l of LANGS) Object.assign(T[l], T_BOOK[l]);

const okLang = (l) => (LANGS.includes(String(l || "").toLowerCase()) ? String(l).toLowerCase() : "");

function pickLang(request, url) {
  const q = okLang(url.searchParams.get("l"));
  if (q) return q;
  const header = request.headers.get("Accept-Language") || "";
  const prefs = header.split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qp = params.find((p) => p.trim().startsWith("q="));
      return { lang: tag.trim().slice(0, 2).toLowerCase(), q: qp ? Number(qp.trim().slice(2)) || 0 : 1 };
    })
    .filter((x) => x.lang)
    .sort((a, b) => b.q - a.q);
  for (const p of prefs) if (LANGS.includes(p.lang)) return p.lang;
  return "en";
}

const diversLabel = (n, lang) => `${n} ${n === 1 ? T[lang].diver : T[lang].divers}`;

// Airtable field in the diver's language, falling back to the English field.
// Booking terms in the diver's language (public/terms/ is English, the rest in a subfolder).
function termsUrl(lang) {
  return lang === "en" ? "/terms/" : `/terms/${lang}/`;
}

// Link back to the chat the diver came from: WhatsApp number first, then Instagram handle.
function chatLink(c) {
  const wa = String(first(c["WhatsApp number"]) || "").replace(/\D/g, "");
  if (wa.length >= 8) return `https://wa.me/${wa}`;
  const ig = String(first(c["Instagram handle"]) || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "");
  return /^[A-Za-z0-9._]{2,30}$/.test(ig) ? `https://ig.me/m/${ig}` : "";
}

// Google Maps link for the meeting point. Centers field "Map link" (optional) wins over a search on the name.
function mapUrl(c, name, island) {
  const own = String(first(c["Map link"]) || "").trim();
  return /^https:\/\//.test(own) ? own
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, island].filter(Boolean).join(", "))}`;
}
function mapLink(c, name, island, t) {
  return `<br><a class="map" href="${esc(mapUrl(c, name, island))}" target="_blank" rel="noopener">${esc(t.map)}</a>`;
}

function tr(rec, field, lang) {
  if (lang !== "en") {
    const v = first(rec[`${field} ${lang.toUpperCase()}`]);
    if (v) return { v, translated: true };
  }
  return { v: first(rec[field]) || "", translated: lang === "en" };
}

// ---------- Router ----------

export default {
  // Cloudflare cron (wrangler.jsonc → triggers): alerts for Talay HQ and the mail campaign sync, every 15 minutes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHqAlerts(env, event.scheduledTime).catch((e) => console.error("hq alerts", e)));
    ctx.waitUntil(runOutreachSync(env).catch((e) => console.error("outreach sync", e))); // mailcampagne: Instantly → Airtable Outreach
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/zone" || url.pathname.startsWith("/zone/")) {
      return handleZone(request, env, ctx);
    }
    if (url.pathname === "/api/demo") {
      return handleDemo(request, env, ctx);
    }
    if (url.pathname === "/api/intake") {
      return handleIntake(request, env, ctx);
    }
    // Called by Make: notifications to the dive center team, push to the zone, the weekly e-mail.
    if (url.pathname === "/api/notify" || url.pathname === "/api/push" || url.pathname === "/api/weekly") {
      const handler = { "/api/notify": handleNotify, "/api/push": handlePush, "/api/weekly": handleWeekly }[url.pathname];
      try {
        return await handler(request, env, ctx);
      } catch (err) {
        console.error(url.pathname, err);
        return new Response(JSON.stringify({ error: String(err.message || err).slice(0, 300) }), { status: 502, headers: { "Content-Type": "application/json" } });
      }
    }
    if (!url.pathname.startsWith("/b/")) return env.ASSETS.fetch(request);
    const lang = pickLang(request, url);
    if (!env.AIRTABLE_TOKEN) {
      return page(problem(T[lang].missingKey, lang), 500, lang);
    }

    try {
      if (url.pathname === "/b/checkout" && request.method === "POST") {
        return await checkout(request, env, ctx, url);
      }
      if (url.pathname === "/b/thanks") {
        return await thanks(request, env, ctx, url);
      }
      if (url.pathname === "/b/manage") {
        return await managePage(env, ctx, url);
      }
      if (url.pathname === "/b/manage/action" && request.method === "POST") {
        return await manageAction(request, env, ctx);
      }

      if (url.pathname === "/b/step" && request.method === "POST") {
        return await pageStep(request, env, ctx);
      }
      if (url.pathname === "/b/order") {
        return await orderInfo(env, ctx, url);
      }

      const slug = url.pathname.slice(3).replace(/\/+$/, "").toLowerCase();
      const found = await loadCenter(env, ctx, slug);
      if (!found) return page(notFound(lang), 404, lang);
      const ref = (url.searchParams.get("c") || "").slice(0, 64);
      const taken = await takenSeats(env, ctx, found.center, found.products.filter((p) => p["Active"]));
      return page(bookingPage(found.center, found.products, slug, env, lang,
        /^[A-Za-z0-9_-]{1,64}$/.test(ref) ? ref : "", linkItems(url), taken), 200, lang, T[lang].pageTitle, true, "sea");
    } catch (err) {
      console.error(err);
      return page(problem(T[lang].loadFail, lang), 502, lang);
    }
  },
};

async function loadBooking(env, ctx, slug, code) {
  if (!/^[a-z0-9-]{1,60}$/.test(slug) || !/^[A-Z0-9]{1,12}$/.test(code)) return null;
  const [center, product] = await Promise.all([
    airtableOne(env, ctx, "Centers", `{Slug} = '${slug}'`),
    airtableOne(env, ctx, "Products",
      `AND({Code} = '${code}', FIND('${slug}', ARRAYJOIN({C slug})))`),
  ]);
  return center && product ? { center, product } : null;
}

// ---------- Stripe ----------

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

// Test or live per center: Centers → "Stripe live" (checkbox) uses STRIPE_LIVE_KEY, every other
// center (demo centers included) keeps STRIPE_SECRET_KEY, the test key. A session id tells its own mode.
const centerLive = (env, center) => !!center["Stripe live"] && !!env.STRIPE_LIVE_KEY;
const stripeKey = (env, live) => (live ? env.STRIPE_LIVE_KEY : env.STRIPE_SECRET_KEY) || "";
const sessionKey = (env, id) => stripeKey(env, String(id).startsWith("cs_live_"));

async function stripe(key, method, path, params, extraHeaders = {}) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...extraHeaders,
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${JSON.stringify(body.error || body)}`);
  return body;
}

// Stripe allows Latin letters, digits and spaces; prefix + suffix stay within 22 characters.
function descriptorSuffix(name) {
  const s = String(name).normalize("NFD").replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\b(dive|diving|divers|center|centre|resort|school)\b/gi, "").replace(/\s+/g, " ").trim().toUpperCase();
  return /[A-Z]/.test(s) ? s.slice(0, 12).trim() : "";
}

// The items of an order travel in Stripe metadata "items": CODE|date|slot|divers|price|deposit;CODE|…
// (prices as they were at payment). Orders from before 26 Oct only have the single-product fields.
function orderItems(m) {
  const list = String(m.items || "").split(";").filter(Boolean).map((x) => {
    const [code, date, slot, n, price, deposit] = x.split("|");
    return { code, date, slot: slot || "", divers: Number(n) || 1, price: Number(price) || 0, deposit: Number(deposit) || 0 };
  });
  if (list.length) return list;
  const n = Number(m.divers) || 1;
  return [{ code: m.product_code || "", date: m.activity_date || "", slot: m.time_slot || "", divers: n,
    price: (Number(m.total_thb) || 0) / n, deposit: (Number(m.deposit_thb) || 0) / n }];
}

async function checkout(request, env, ctx, url) {
  let input;
  try { input = await request.json(); } catch { return json({ error: T.en.invalid }, 400); }
  const lang = okLang(input.lang) || "en";
  const t = T[lang];
  const slug = String(input.slug || "").toLowerCase();
  const ref = /^[A-Za-z0-9_-]{1,64}$/.test(String(input.ref || "")) ? String(input.ref) : "";
  // No " or \ in the note: Make puts it in a JSON body (PATCH Bookings → Note).
  const note = String(input.note || "").replace(/[|;]/g, " ").replace(/["\\]/g, "'").replace(/\s+/g, " ").trim().slice(0, 300);
  // Old pages send one product at the top level.
  const wanted = Array.isArray(input.items) ? input.items
    : [{ code: input.code, date: input.date, divers: input.divers, slot: input.slot }];
  if (!wanted.length || wanted.length > MAX_ITEMS) return json({ error: t.tooMany }, 400);

  // Never trust the browser: reload prices and re-check every rule here.
  const found = await loadCenter(env, ctx, slug);
  if (!found) return json({ error: t.notFoundTitle }, 404);
  const { center, products } = found;
  if (wanted.length > 1 && !center["Multi booking"]) return json({ error: t.invalid }, 400);
  const key = stripeKey(env, centerLive(env, center));
  if (!key) return json({ error: t.notAvailable }, 503);
  const tz = centerTz(center);
  const closed = closedDates(center);
  const full = fullDates(center);
  const taken = await takenSeats(env, ctx, center, products.filter((p) => p["Active"]));
  const centerName = first(center["Name"]) || "Dive center";

  const items = [];
  for (const w of wanted) {
    const code = String(w.code || "").toUpperCase();
    const product = products.find((p) => String(first(p["Code"]) || "").toUpperCase() === code);
    if (!product) return json({ error: t.notFoundTitle }, 404);
    if (!product["Active"]) return json({ error: `${CLOSED[lang].title}: ${tr(product, "Name", lang).v || code}` }, 409);
    const date = String(w.date || "");
    const divers = Number(w.divers);
    const minDate = earliestDate(num(product["Cutoff hour"]) || 15, tz);
    const maxDate = plusDays(earliestDate(99, tz), 180);
    const days = productDays(product);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < minDate || date > maxDate) {
      return json({ error: t.chooseFrom(fmtDate(minDate, lang)) }, 400);
    }
    for (let k = 0; k < days; k++) if (closed.includes(plusDays(date, k))) return json({ error: t.notOpen }, 400);
    if (!Number.isInteger(divers) || divers < 1 || divers > MAX_DIVERS) {
      return json({ error: t.chooseDivers }, 400);
    }
    const kind = slotKind(product, days);
    const slot = kind === "CHOOSE" ? String(w.slot || "").toUpperCase() : kind;
    if (kind === "CHOOSE" && slot !== "AM" && slot !== "PM") return json({ error: t.chooseSlot }, 400);
    if (seatProblem({ code, days, slot: kind, maxDay: num(product["Max per day"]) }, full, taken, date, slot, divers)) {
      return json({ error: t.dayFull }, 409);
    }
    items.push({
      code, date, divers, slot: slot === "AM" || slot === "PM" || slot === "DAY" ? slot : "",
      name: first(product["Name"]) || code, // English name: used in Airtable, Make and mails
      shownName: tr(product, "Name", lang).v || first(product["Name"]) || code,
      price: num(product["Price THB"]), deposit: num(product["Deposit THB"]),
    });
  }

  const total = items.reduce((a, x) => a + x.price * x.divers, 0);
  const paid = items.reduce((a, x) => a + x.deposit * x.divers, 0);
  const one = items.length === 1 ? items[0] : null;
  const back = `${url.origin}/b/${slug}?${items.map((x) => `p=${x.code}*${x.divers}@${x.date}${x.slot === "AM" || x.slot === "PM" ? `~${x.slot}` : ""}`).join("&")}${ref ? `&c=${ref}` : ""}&l=${lang}`;

  const meta = {
    center_slug: slug, center_name: centerName, lead_ref: ref, lang, note,
    count: String(items.length),
    items: items.map((x) => [x.code, x.date, x.slot, x.divers, x.price, x.deposit].join("|")).join(";"),
    total_thb: String(total), deposit_thb: String(paid), balance_thb: String(total - paid),
    // One product: the same fields as before, so Make keeps working without the order step.
    ...(one ? { product_code: one.code, product_name: one.name, activity_date: one.date, divers: String(one.divers), time_slot: SLOT_EN[one.slot] } : {}),
  };
  const params = {
    mode: "payment",
    locale: lang,
    "phone_number_collection[enabled]": "true",
    success_url: `${url.origin}/b/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: back,
    "payment_intent_data[description]": items.map((x) => `${x.name} at ${centerName}, ${x.date}${x.slot ? ` ${SLOT_EN[x.slot]}` : ""}, ${x.divers}x`).join("; ").slice(0, 900),
    "custom_text[submit][message]": t.termsStripe,
  };
  items.forEach((x, i) => {
    const when = [fmtDate(x.date, lang), { AM: t.am, PM: t.pm, DAY: t.day }[x.slot] || ""].filter(Boolean).join(", ");
    params[`line_items[${i}][quantity]`] = String(x.divers);
    params[`line_items[${i}][price_data][currency]`] = "thb";
    params[`line_items[${i}][price_data][unit_amount]`] = String(x.deposit * 100); // THB in satang
    params[`line_items[${i}][price_data][product_data][name]`] = t.deposit(x.shownName, centerName);
    params[`line_items[${i}][price_data][product_data][description]`] =
      t.stripeDesc(when, diversLabel(x.divers, lang), thb((x.price - x.deposit) * x.divers, lang));
  });
  // Card statement: "TALAY* <CENTER>" (prefix set in Stripe, suffix per center).
  const suffix = descriptorSuffix(centerName);
  if (suffix) params["payment_intent_data[statement_descriptor_suffix]"] = suffix;
  for (const [k, v] of Object.entries(meta)) {
    params[`metadata[${k}]`] = v;
    params[`payment_intent_data[metadata][${k}]`] = v;
  }
  let session;
  try {
    session = await stripe(key, "POST", "checkout/sessions", params);
  } catch (err) {
    // A rejected statement descriptor must never block a booking: retry without it.
    if (!suffix || !/statement_descriptor/.test(String(err.message))) throw err;
    delete params["payment_intent_data[statement_descriptor_suffix]"];
    session = await stripe(key, "POST", "checkout/sessions", params);
  }
  return json({ url: session.url });
}

// Called by Make (Talay - bookings, test and live) right after the payment: one row per booking.
// talay.io/b/order?session_id=cs_… → { count, items: [{ item, product_code, product_name, activity_date,
// time_slot, divers, total_thb, deposit_thb, balance_thb }], note, confirm, center_text, … }
async function orderInfo(env, ctx, url) {
  const id = url.searchParams.get("session_id") || "";
  if (!sessionKey(env, id) || !/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return json({ error: "Unknown session." }, 404);
  const s = await stripe(sessionKey(env, id), "GET", `checkout/sessions/${id}`);
  const m = s.metadata || {};
  const lang = okLang(m.lang) || "en";
  const t = T[lang];
  const found = m.center_slug ? await loadCenter(env, ctx, m.center_slug) : null;
  const byCode = (code) => (found?.products || []).find((p) => String(first(p["Code"]) || "").toUpperCase() === code) || {};
  const items = orderItems(m).map((x, i) => {
    const p = byCode(x.code);
    return {
      item: i + 1, product_code: x.code, product_name: first(p["Name"]) || m.product_name || x.code,
      shown: tr(p, "Name", lang).v || first(p["Name"]) || m.product_name || x.code,
      activity_date: x.date, days: productDays(p), time_slot: SLOT_EN[x.slot] || "", divers: x.divers,
      total_thb: x.price * x.divers, deposit_thb: x.deposit * x.divers, balance_thb: (x.price - x.deposit) * x.divers,
    };
  });
  const total = items.reduce((a, x) => a + x.total_thb, 0), paid = items.reduce((a, x) => a + x.deposit_thb, 0);
  const payer = s.customer_details?.name || "";
  const firstName = cap(String(payer).trim().split(/\s+/)[0] || "");
  const when = (x, l, lower = false) => {
    const slot = { Morning: T[l].am, Afternoon: T[l].pm, "Full day": T[l].day }[x.time_slot] || "";
    return [fmtDays(x.activity_date, x.days, l), lower ? slot.toLowerCase() : slot].filter(Boolean).join(", ");
  };
  const ref = await orderRef(id);
  // One WhatsApp for the whole order (Make sends it after the last booking). Empty for a single booking:
  // Make then uses Bookings → Confirm text, as before (ifempty in Respond.io 15).
  const confirm = items.length < 2 ? "" : [
    firstName ? t.confirmHi(firstName) : t.confirmHiNo, `${t.bookingNo}: ${ref}`, "",
    ...[...items].sort((x, y) => x.activity_date.localeCompare(y.activity_date))
      .map((x) => `• ${x.shown}, ${when(x, lang, lang !== "de")}, ${diversLabel(x.divers, lang)}`), "",
    t.confirmPaid(thb(paid, lang)), t.confirmShop(thb(total - paid, lang)), "", t.confirmEnd,
  ].join("\n");
  const centerText = [
    `New booking via Talay (${items.length} ${items.length === 1 ? "activity" : "activities"}), booking number ${ref}`,
    `Diver: ${payer || "-"} ${s.customer_details?.phone || ""}`.trim(), "",
    ...items.map((x) => `- ${x.product_name}: ${when(x, "en")}, ${diversLabel(x.divers, "en")}. Paid online ${thb(x.deposit_thb)} THB, at the shop ${thb(x.balance_thb)} THB.`),
    "", `Total paid online: ${thb(paid)} THB. To collect at the shop: ${thb(total - paid)} THB.`,
    ...(m.note ? ["", `Note from the diver: ${m.note}`] : []),
  ].join("\n");
  return json({
    session_id: id, paid: s.payment_status === "paid", center_slug: m.center_slug || "", center_name: m.center_name || "",
    order_ref: ref, lead_ref: m.lead_ref || "", lang, note: m.note || "", payer_name: payer, payer_phone: s.customer_details?.phone || "",
    count: items.length, total_thb: total, deposit_thb: paid, balance_thb: total - paid,
    items: items.map(({ shown, ...x }) => x), confirm, center_text: centerText,
    ref_line: `${t.bookingNo}: ${ref}`, // for the single-booking WhatsApp (Make adds it under Confirm text)
  });
}

async function thanks(request, env, ctx, url) {
  const id = url.searchParams.get("session_id") || "";
  let lang = pickLang(request, url);
  if (!sessionKey(env, id) || !/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return page(notFound(lang), 404, lang);
  const s = await stripe(sessionKey(env, id), "GET", `checkout/sessions/${id}`);
  const m = s.metadata || {};
  lang = okLang(m.lang) || lang;
  const t = T[lang];
  if (s.payment_status !== "paid") {
    return page(problem(t.notPaid, lang), 402, lang);
  }
  const found = await loadCenter(env, ctx, String(m.center_slug || ""));
  const c = found?.center || {};
  const byCode = (code) => (found?.products || []).find((p) => String(first(p["Code"]) || "").toUpperCase() === code) || {};
  const logo = first(c["Logo"])?.thumbnails?.large?.url || first(c["Logo"])?.url || "";
  const assistant = first(c["Assistant name"]) || m.center_name || "";
  const meeting = cap(tr(c, "Meeting point", lang).v);
  const chat = chatLink(c);
  const items = orderItems(m).sort((a, b) => a.date.localeCompare(b.date)).map((x) => {
    const p = byCode(x.code);
    const english = first(p["Name"]) || m.product_name || x.code;
    return { ...x, p, days: productDays(p), name: tr(p, "Name", lang).v || english, checkIn: cap(tr(p, "Check-in", lang).v),
      isCourse: x.code === "OW" || /course|diver/i.test(english) };
  });
  // Check-in per activity, with its name above it (once per product).
  const checkIns = items.filter((x, i) => x.checkIn && items.findIndex((y) => y.code === x.code) === i);
  const ref = await orderRef(id);
  const slotWord = { AM: t.am, PM: t.pm, DAY: t.day };

  return page(`
<header class="center">
  ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(m.center_name)} logo">` : ""}
  <div><p class="center-name">${esc(m.center_name)}</p>${c["Island"] ? `<p class="island">${esc(first(c["Island"]))}</p>` : ""}</div>
</header>
<main>
  <h1>${esc(t.booked)}</h1>
  <p class="oref">${esc(t.bookingNo)} <b>${esc(ref)}</b></p>
  <ul class="booked">${items.map((x) => `<li><strong>${esc(x.name)}</strong>, ${esc(fmtDays(x.date, x.days, lang))}${slotWord[x.slot] ? `, ${esc(lang === "de" ? slotWord[x.slot] : slotWord[x.slot].toLowerCase())}` : ""}, ${esc(diversLabel(x.divers, lang))}</li>`).join("")}</ul>
  <section class="slate" aria-label="${esc(t.paidNow)}">
    <div class="above">
      <div class="row now"><span>${esc(t.paidNow)}</span><span><b>${thb(Number(m.deposit_thb), lang)}</b> THB</span></div>
    </div>
    <svg class="waterline" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 12 C 50 2, 100 22, 150 12 S 250 2, 300 12 S 380 20, 400 12 V24 H0Z"/>
    </svg>
    <div class="below">
      <div class="row"><span>${esc(t.payShop)}</span><span><b>${thb(Number(m.balance_thb), lang)}</b> THB</span></div>
    </div>
  </section>
  <p class="msg">${esc(t.change)}</p>
  <h2 class="next">${esc(t.nextTitle)}</h2>
  ${items.some((x) => x.isCourse) ? `<p class="course">${esc(t.courseNote)}</p>` : ""}
  <dl class="practical">
    ${checkIns.length ? `<div><dt>${esc(t.checkIn)}</dt><dd>${checkIns.map((x) => (checkIns.length > 1 || items.length > 1 ? `<b>${esc(x.name)}</b>: ` : "") + esc(x.checkIn)).join("<br>")}</dd></div>` : ""}
    ${meeting ? `<div><dt>${esc(t.meeting)}</dt><dd>${esc(meeting)}${mapLink(c, m.center_name, first(c["Island"]) || "", t)}</dd></div>` : ""}
    <div><dt>${esc(t.bring)}</dt><dd>${esc(t.bringText)}</dd></div>
  </dl>
  <p class="hint" style="margin-top:2rem">${esc(t.questions(assistant))}</p>
  ${chat ? `<a class="book chat" href="${esc(chat)}">${esc(t.backToChat)}</a>` : ""}
</main>
<script>try{localStorage.removeItem(${JSON.stringify(`talay-b:${m.center_slug || ""}:${m.lead_ref || "-"}`).replace(/</g, "\\u003c")})}catch(e){}</script>`, 200, lang, "", false, "sea");
}

// ---------- Manage booking (for the dive center) ----------
// Link in the center's email: talay.io/b/manage?t=[Manage token]. The token is a
// random uuid made by Make when the booking is created; only the center gets it.
// Rule (pilot): changes stay possible after the 2-hour window, but the page warns
// and Make mails Talay ("late").

const WINDOW_MS = 2 * 3600 * 1000;
const okToken = (t) => /^[0-9a-fA-F-]{20,64}$/.test(String(t || ""));

async function airtableFind(env, table, formula) {
  // No cache: the status of a booking must always be current.
  const api = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`);
  api.searchParams.set("filterByFormula", formula);
  api.searchParams.set("maxRecords", "1");
  const res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable ${table}: ${res.status} ${await res.text()}`);
  return (await res.json()).records?.[0] || null;
}

async function loadManaged(env, ctx, token) {
  if (!okToken(token)) return null;
  const rec = await airtableFind(env, "Bookings", `{Manage token} = '${token}'`);
  if (!rec) return null;
  const f = rec.fields;
  const sessionId = first(f["Stripe session ID"]) || "";
  const key = sessionKey(env, sessionId);
  if (!key || !/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return null;
  const session = await stripe(key, "GET", `checkout/sessions/${sessionId}`);
  const m = session.metadata || {};
  // Which product: Bookings → P code (lookup) when it exists, otherwise the order (one product) in Stripe.
  const items = orderItems(m);
  const code = String(first(f["P code"]) || (items.length === 1 ? items[0].code : "") || m.product_code || "");
  const found = await loadBooking(env, ctx, m.center_slug, code);
  const created = Date.parse(rec.createdTime);
  return {
    rec, f, session, m, key, count: items.length,
    center: found?.center || {}, product: found?.product || {},
    created, late: Date.now() > created + WINDOW_MS,
    cancelled: /cancel|refund/i.test(String(first(f["Status"]) || "")),
  };
}

const thaiTime = (ms) => new Date(ms).toLocaleString("en-GB", {
  timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

async function managePage(env, ctx, url) {
  const token = url.searchParams.get("t") || "";
  if (!env.STRIPE_SECRET_KEY || !env.MAKE_CHANGES_URL || !env.MAKE_CHANGES_KEY) {
    return page(problem("Booking changes are not set up yet.", "en"), 500, "en");
  }
  const b = await loadManaged(env, ctx, token);
  if (!b) {
    return page(`<main class="empty"><h1>This link doesn't work</h1>
  <p>Open the link again from the booking email, or reply to that email.</p></main>`, 404, "en");
  }
  const { f, m, center, product } = b;
  const centerName = first(center["Name"]) || m.center_name || "Dive center";
  const logo = first(center["Logo"])?.thumbnails?.large?.url || first(center["Logo"])?.url || "";
  const ref = first(f["Ref"]) || "";
  const name = first(f["P name"]) || m.product_name || "";
  const date = String(first(f["Activity date"]) || m.activity_date || "").slice(0, 10);
  const divers = Number(first(f["Group size"])) || Number(m.divers) || 1;
  const paid = Number(first(f["Deposit paid THB"])) || Number(m.deposit_thb) || 0;
  const diver = first(f["Payer name"]) || "";
  const minDate = earliestDate(num(product["Cutoff hour"]) || 15);
  const maxDate = plusDays(minDate, 180);
  const data = { token, minDate, maxDate, current: date, paid: thb(paid) };

  const windowLine = b.late
    ? `<p class="warn">The 2-hour window for changes has passed (booked ${esc(thaiTime(b.created))}, Koh Tao time). You can still move or cancel, but Talay will be notified.</p>`
    : `<p class="hint">You can move or cancel this booking until ${esc(thaiTime(b.created + WINDOW_MS))} (Koh Tao time).</p>`;

  return page(`
<header class="center">
  ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(centerName)} logo">` : ""}
  <div><p class="center-name">${esc(centerName)}</p><p class="island">Manage booking</p></div>
</header>
<main>
  <h1>${esc(ref || "Booking")}</h1>
  <p class="intro"><strong>${esc(name)}</strong>, ${esc(date ? fmtDate(date, "en") : "")}, ${esc(diversLabel(divers, "en"))}${diver ? `, ${esc(diver)}` : ""}. Deposit paid online: ${thb(paid)} THB.</p>
  ${b.cancelled ? `<p class="msg">This booking is cancelled. The diver's deposit has been refunded.</p>` : `
  <p id="msg" class="msg" role="status" hidden></p>
  <div id="actions">
  ${windowLine}
  <section class="field" style="margin-top:2rem">
    <label for="date">Move to another date</label>
    <input id="date" type="date" min="${minDate}" max="${maxDate}" aria-describedby="date-error">
    <p id="date-error" class="error" role="alert" hidden></p>
    <button type="button" id="move" class="book" style="margin-top:1rem">Move booking</button>
    <p class="hint">If the diver wrote on WhatsApp, they get a WhatsApp message with the new date.</p>
  </section>
  <section class="field" style="margin-top:2.5rem;padding-top:1.5rem;border-top:1px solid var(--line)">
    <label>Cancel</label>
    <button type="button" id="cancel" class="book danger">Cancel and refund ${thb(paid)} THB</button>
    <p class="hint">The full deposit goes back to the diver's card, and a diver who wrote on WhatsApp gets a WhatsApp message.</p>
  </section>
  </div>`}
</main>
<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>
(() => {
  const d = JSON.parse(document.getElementById("data").textContent);
  const $ = (id) => document.getElementById(id);
  if (!$("move")) return;
  const msg = $("msg");
  function send(body, btn, doneText) {
    $("move").disabled = true; $("cancel").disabled = true;
    msg.hidden = false; msg.textContent = "Saving…";
    msg.scrollIntoView({ behavior: "smooth", block: "center" });
    fetch("/b/manage/action", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ t: d.token }, body)) })
      .then((r) => r.json())
      .then((r) => {
        if (r.ok) {
          msg.textContent = r.message || doneText;
          $("actions").hidden = true;
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        msg.textContent = r.error || "Something went wrong. Try again.";
        $("move").disabled = false; $("cancel").disabled = false;
      })
      .catch(() => { msg.textContent = "No connection. Try again."; $("move").disabled = false; $("cancel").disabled = false; });
  }
  $("move").onclick = () => {
    const v = $("date").value, box = $("date-error");
    let problem = "";
    if (!v) problem = "Choose the new date first.";
    else if (v === d.current) problem = "That is already the booked date.";
    else if (v < d.minDate) problem = "That date is too soon. Choose " + d.minDate + " or later.";
    else if (v > d.maxDate) problem = "That date is too far ahead.";
    box.hidden = !problem; box.textContent = problem; $("date").classList.toggle("invalid", !!problem);
    if (problem) return;
    send({ action: "move", date: v }, $("move"), "Booking moved. The diver has been informed.");
  };
  $("cancel").onclick = () => {
    if (!confirm("Cancel this booking and refund " + d.paid + " THB to the diver?")) return;
    send({ action: "cancel" }, $("cancel"), "Booking cancelled and refunded. The diver has been informed.");
  };
})();
</script>`, 200, "en", "Manage booking");
}

async function manageAction(request, env, ctx) {
  let input;
  try { input = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (!env.STRIPE_SECRET_KEY || !env.MAKE_CHANGES_URL || !env.MAKE_CHANGES_KEY) {
    return json({ error: "Booking changes are not set up yet." }, 503);
  }
  const token = String(input.t || "");
  const b = await loadManaged(env, ctx, token);
  if (!b) return json({ error: "This link doesn't work." }, 404);
  if (b.cancelled) return json({ error: "This booking is already cancelled." }, 409);

  const tellMake = async (action, newDate = "") => {
    const u = new URL(env.MAKE_CHANGES_URL);
    u.searchParams.set("key", env.MAKE_CHANGES_KEY);
    u.searchParams.set("token", token);
    u.searchParams.set("action", action);
    u.searchParams.set("new_date", newDate);
    u.searchParams.set("late", b.late ? "true" : "false");
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Make: ${res.status} ${await res.text()}`);
  };

  if (input.action === "move") {
    const date = String(input.date || "");
    const minDate = earliestDate(num(b.product["Cutoff hour"]) || 15);
    const maxDate = plusDays(minDate, 180);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < minDate || date > maxDate) {
      return json({ error: `Choose a date between ${fmtDate(minDate, "en")} and ${fmtDate(maxDate, "en")}.` }, 400);
    }
    await tellMake("move", date);
    return json({ ok: true, message: `Booking moved to ${fmtDate(date, "en")}. A diver who wrote on WhatsApp gets a WhatsApp message.` });
  }

  if (input.action === "cancel") {
    const pi = typeof b.session.payment_intent === "string" ? b.session.payment_intent : b.session.payment_intent?.id;
    if (!pi) return json({ error: "No payment found for this booking. Contact Talay." }, 409);
    try {
      // An order with several bookings: refund only the deposit of this booking.
      const paid = Number(first(b.f["Deposit paid THB"])) || 0;
      if (b.count > 1 && !paid) return json({ error: "No deposit found for this booking. Contact Talay." }, 409);
      await stripe(b.key, "POST", "refunds",
        { payment_intent: pi, "metadata[cancelled_by]": "center", "metadata[booking]": String(first(b.f["Ref"]) || ""),
          ...(b.count > 1 ? { amount: String(Math.round(paid * 100)) } : {}) },
        { "Idempotency-Key": `cancel-${token}` });
    } catch (err) {
      if (!/already.?refunded/i.test(String(err.message))) throw err;
    }
    await tellMake("cancel");
    return json({ ok: true, message: "Booking cancelled. The full deposit is refunded to the diver's card. A diver who wrote on WhatsApp gets a WhatsApp message." });
  }
  return json({ error: "Unknown action." }, 400);
}

// ---------- Airtable ----------

// Where divers drop off on the booking page: one row per visit and step in the Airtable table
// "Page steps" (Slug, Visit, Step, Lead, Lang, plus a Created time field). Talay HQ → Conversie
// counts the different visits per step. Never blocks the page: errors only go to the log.
const PAGE_STEPS = ["open", "group", "product", "done", "pay"];
async function pageStep(request, env, ctx) {
  let b = null;
  try { b = JSON.parse((await request.text()).slice(0, 1000)); } catch { /* not JSON */ }
  if (b && /^[a-z0-9-]{1,60}$/.test(b.s) && /^[A-Za-z0-9]{8,40}$/.test(b.v) && PAGE_STEPS.includes(b.st)) {
    const fields = { Slug: b.s, Visit: b.v, Step: b.st, Lead: /^[A-Za-z0-9_-]{1,64}$/.test(b.c || "") ? b.c : "", Lang: /^[a-z]{2}$/.test(b.l || "") ? b.l : "" };
    ctx.waitUntil(fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent("Page steps")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    }).then(async (r) => { if (!r.ok) console.error("page step", r.status, (await r.text()).slice(0, 200)); }).catch((e) => console.error("page step", e)));
  }
  return new Response(null, { status: 204 });
}

async function airtableOne(env, ctx, table, formula) {
  const api = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`);
  api.searchParams.set("filterByFormula", formula);
  api.searchParams.set("maxRecords", "1");

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.talay.internal/${table}?${api.searchParams}`);
  const hit = await cache.match(cacheKey);
  if (hit) return (await hit.json()).records?.[0]?.fields || null;

  const res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable ${table}: ${res.status} ${await res.text()}`);
  const body = await res.text();
  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` },
  })));
  return JSON.parse(body).records?.[0]?.fields || null;
}

async function airtableList(env, ctx, table, formula) {
  const api = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`);
  api.searchParams.set("filterByFormula", formula);
  api.searchParams.set("pageSize", "100");

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.talay.internal/list/${table}?${api.searchParams}`);
  const hit = await cache.match(cacheKey);
  if (hit) return ((await hit.json()).records || []).map((r) => r.fields);

  const records = [];
  for (let page = 0; page < 10; page++) { // at most 1,000 rows
    const res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
    if (!res.ok) throw new Error(`Airtable ${table}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    records.push(...(data.records || []));
    if (!data.offset) break;
    api.searchParams.set("offset", data.offset);
  }
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify({ records }), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` },
  })));
  return records.map((r) => r.fields);
}

// ---------- Helpers ----------

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const first = (v) => (Array.isArray(v) ? v[0] : v);
const num = (v) => Number(first(v)) || 0;
const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
// Thousands separator per language: 12,500 (en), 12.500 (nl/de/es), 12 500 (fr).
const SEP = { en: ",", nl: ".", de: ".", es: ".", fr: "\u00A0" };
const thb = (n, lang = "en") => Math.round(n).toLocaleString("en-US").replace(/,/g, SEP[lang] ?? ",");

function earliestDate(cutoffHour, tz = "Asia/Bangkok") {
  // Booking for day D closes at the cutoff hour (time of the dive center) on D-1.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return plusDays(`${parts.year}-${parts.month}-${parts.day}`, Number(parts.hour) < cutoffHour ? 1 : 2);
}
function plusDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Pages ----------

// ---------- Booking page (several bookings, one payment) ----------
// talay.io/b/[slug] shows every active product of the center. Links from the chat can pre-fill it:
//   ?p=FUN                         one product (old links keep working)
//   ?p=FUN*2@2026-11-26~PM&p=OW*3  several products, with number of divers, date and morning/afternoon
// The same product with the same date twice (Mia sent the link twice) is shown once.
// Optional Airtable fields (the page shows less when they are empty):
//   Products: Time slot ("Morning or afternoon", "Morning", "Afternoon", "Full day"), Days (number),
//             Max group (number), Dives (number), Max depth, Level (+ FR/DE/ES/NL), Bring (+ FR/DE/ES/NL),
//             Not included (+ FR/DE/ES/NL), Short (label in the plan, default the Code),
//             Group (who it is for: New, Certified and/or Level up; several allowed), Max per day (number)
//   Centers:  Photos (first one on top), Google rating, Google reviews, Closed dates (2026-12-24, 2026-12-25),
//             Timezone (default Asia/Bangkok), Multi booking (checkbox: "Book another one" and one payment for all)

const MAX_ITEMS = 8;

// Morning/afternoon per product: "" (not asked), AM, PM, CHOOSE (diver picks), DAY (whole day).
function slotKind(p, days) {
  if (days > 1) return "DAY";
  const v = String(first(p["Time slot"]) || "").toLowerCase();
  const am = /morning|\bam\b/.test(v), pm = /afternoon|\bpm\b/.test(v);
  if ((am && pm) || /both|either|choose/.test(v)) return "CHOOSE";
  if (am) return "AM";
  if (pm) return "PM";
  return /full|whole|day/.test(v) ? "DAY" : "";
}
function productDays(p) {
  const n = num(p["Days"]);
  if (n >= 1) return Math.min(Math.round(n), 14);
  const m = String(first(p["Duration"]) || "").match(/(\d+)\s*(?:-\s*\d+\s*)?days?\b/i);
  return m ? Math.min(Math.max(Number(m[1]), 1), 14) : 1;
}
// Who the activity is for: "new" (never dived), "cert" (certified: fun dives, refresh), "up" (next course).
// Products → Group (New, Certified, Level up; several allowed). Empty: guessed from code, name and category.
const GROUPS = ["new", "cert", "up"];
function productGroups(p) {
  const set = [].concat(p["Group"] || []).join(",").toLowerCase();
  const out = GROUPS.filter((g) => ({ new: /new|beginner/, cert: /certif/, up: /level|advanc/ })[g].test(set));
  if (out.length) return out;
  const v = `${first(p["Code"]) || ""} ${first(p["Name"]) || ""} ${first(p["Category"]) || ""}`.toLowerCase();
  if (/refresh|review/.test(v)) return ["cert"];
  const fun = /fun ?dive|dive trip|package|\bpack\b|\d+\s*-?\s*pack/.test(v);
  if (/advanced|\baow\b|rescue|special|deep|nitrox|wreck|night|navigation|buoyancy|adventure|divemaster|\bdds\b/.test(v)) return fun ? ["cert", "up"] : ["up"];
  return fun || /\bfun\b/.test(v) ? ["cert"] : ["new"];
}
const SLOT_EN = { AM: "Morning", PM: "Afternoon", DAY: "Full day", "": "" };

// Center time: Centers → Timezone (IANA name, default Asia/Bangkok).
function centerTz(c) {
  const tz = String(first(c?.["Timezone"]) || "").trim();
  try { if (tz) { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } } catch { /* unknown zone */ }
  return "Asia/Bangkok";
}
function closedDates(c) {
  return [...new Set(String(first(c["Closed dates"]) || "").match(/\d{4}-\d{2}-\d{2}/g) || [])];
}
// Days the center marked as full in the zone: Centers → "Full dates", one line per day:
// "2026-11-26" (whole day), "2026-11-26 AM" or "2026-11-26 PM". Same format as parseFull in src/zone.js.
function fullDates(c, from = "") {
  const out = {};
  for (const m of String(first(c["Full dates"]) || "").matchAll(/(\d{4}-\d{2}-\d{2})(?:[ \t]+(AM|PM|DAY))?/gi)) {
    if (m[1] < from) continue;
    const part = (m[2] || "DAY").toUpperCase(), had = out[m[1]];
    out[m[1]] = !had || had === part ? part : "DAY";
  }
  return out;
}
// Divers already booked per product and day (and per morning/afternoon when the diver chooses),
// only for products with Products → "Max per day": { FUN: { "2026-11-26|AM": 6 }, OW: { "2026-11-26|": 3 } }.
async function takenSeats(env, ctx, c, products) {
  const capped = products.filter((p) => num(p["Max per day"]) > 0);
  if (!capped.length) return {};
  const name = String(first(c["Name"]) || "").replace(/'/g, "\\'");
  const from = plusDays(earliestDate(99, centerTz(c)), -30); // multi-day courses that started earlier still count
  let rows = [];
  try {
    rows = await airtableList(env, ctx, "Bookings",
      `AND(ARRAYJOIN({Center}) & '' = '${name}', IS_AFTER({Activity date}, DATETIME_PARSE('${from}', 'YYYY-MM-DD')), NOT(REGEX_MATCH(LOWER({Status} & ''), 'cancel|refund')))`);
  } catch (e) { console.error("taken seats", e); return {}; }
  const out = {};
  for (const b of rows) {
    const code = String(first(b["P code"]) || "").toUpperCase();
    const p = capped.find((x) => String(first(x["Code"]) || "").toUpperCase() === code);
    const date = String(first(b["Activity date"]) || "").slice(0, 10);
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const days = productDays(p);
    const v = String(first(b["Time slot"]) || "").toLowerCase();
    const part = slotKind(p, days) !== "CHOOSE" ? "" : /afternoon|\bpm\b/.test(v) ? "PM" : "AM";
    const n = num(b["Group size"]) || 1;
    const m = (out[code] = out[code] || {});
    for (let k = 0; k < days; k++) { const key = `${plusDays(date, k)}|${part}`; m[key] = (m[key] || 0) + n; }
  }
  return out;
}
// Can n more divers book this product on this day (and morning/afternoon)? Same rules as the page.
function seatProblem(view, full, taken, date, slot, n) {
  for (let k = 0; k < view.days; k++) {
    const day = plusDays(date, k), f = full[day];
    if (f === "DAY" || (f && (slot === f || view.slot === f))) return true;
    const part = view.slot === "CHOOSE" ? slot : "";
    if (view.maxDay && ((taken[view.code] || {})[`${day}|${part}`] || 0) + n > view.maxDay) return true;
  }
  return false;
}

function productView(p, c, lang) {
  const t = T[lang];
  const days = productDays(p);
  const slot = slotKind(p, days);
  const code = String(first(p["Code"]) || "").toUpperCase();
  const level = tr(p, "Level", lang).v
    || [first(p["Prerequisites"]), num(p["Min age"]) ? t.minAge(num(p["Min age"])) : ""].filter(Boolean).join(", ");
  return {
    code,
    name: tr(p, "Name", lang).v || first(p["Name"]) || code,
    groups: productGroups(p),
    refresh: /refresh|review/i.test(`${first(p["Code"]) || ""} ${first(p["Name"]) || ""} ${first(p["Category"]) || ""}`),
    price: num(p["Price THB"]),
    deposit: num(p["Deposit THB"]),
    slot, days,
    maxGroup: num(p["Max group"]) || 0,
    maxDay: num(p["Max per day"]) || 0,
    minDate: earliestDate(num(p["Cutoff hour"]) || 15, centerTz(c)),
    short: String(first(p["Short"]) || code).slice(0, 8),
    info: {
      dives: num(p["Dives"]) ? t.dives(num(p["Dives"])) : "",
      depth: String(first(p["Max depth"]) || ""),
      duration: cap(tr(p, "Duration", lang).v),
      level: cap(level),
      inc: cap(tr(p, "Included", lang).v),
      not: cap(tr(p, "Not included", lang).v),
      bring: cap(tr(p, "Bring", lang).v),
      checkIn: cap(tr(p, "Check-in", lang).v),
    },
  };
}

// Items from the link: ?p=FUN*2@2026-11-26~PM (number, date and time are optional), repeated or comma-separated.
function linkItems(url) {
  const out = [];
  for (const raw of url.searchParams.getAll("p")) {
    for (const part of raw.split(",")) {
      const m = part.trim().match(/^([A-Za-z0-9]{1,12})(?:\*(\d{1,2}))?(?:@(\d{4}-\d{2}-\d{2}))?(?:~(AM|PM))?$/i);
      if (!m) continue;
      const it = { code: m[1].toUpperCase(), n: Math.min(Math.max(Number(m[2]) || 1, 1), MAX_DIVERS), date: m[3] || "", slot: (m[4] || "").toUpperCase() };
      if (!out.some((x) => x.code === it.code && x.date === it.date)) out.push(it);
    }
  }
  return out.slice(0, MAX_ITEMS);
}

async function loadCenter(env, ctx, slug) {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  const [center, products] = await Promise.all([
    airtableOne(env, ctx, "Centers", `{Slug} = '${slug}'`),
    airtableList(env, ctx, "Products", `FIND('${slug}', ARRAYJOIN({C slug}))`),
  ]);
  if (!center) return null;
  const own = products.filter((p) => [].concat(p["C slug"] || []).map(String).includes(slug));
  return { center, products: own };
}

function bookingPage(c, products, slug, env, lang, ref, wanted, taken = {}) {
  const t = T[lang];
  const centerName = first(c["Name"]) || "Dive center";
  const island = first(c["Island"]) || "";
  const assistant = first(c["Assistant name"]) || centerName;
  const logo = first(c["Logo"])?.thumbnails?.large?.url || first(c["Logo"])?.url || "";
  const photo = first(c["Photos"])?.thumbnails?.large?.url || first(c["Photos"])?.url || "";
  const rating = num(c["Google rating"]);
  const reviews = num(c["Google reviews"]);
  const meeting = cap(tr(c, "Meeting point", lang).v);
  const chat = chatLink(c);
  const key = stripeKey(env, centerLive(env, c));
  const testMode = key.startsWith("sk_test_");
  const multi = !!c["Multi booking"];

  // Within a group: Refresh first, then short and cheap before long and expensive.
  const views = products.filter((p) => p["Active"]).map((p) => productView(p, c, lang))
    .filter((p) => p.code && p.price > 0)
    .sort((a, b) => b.refresh - a.refresh || a.days - b.days || a.price - b.price);
  const known = new Set(views.map((p) => p.code));
  const unknown = wanted.filter((w) => !known.has(w.code)).map((w) => {
    const p = products.find((x) => String(first(x["Code"]) || "").toUpperCase() === w.code);
    return p ? tr(p, "Name", lang).v || first(p["Name"]) || w.code : "";
  }).filter(Boolean);
  let init = wanted.filter((w) => known.has(w.code));
  if (!multi) init = init.slice(0, 1);

  const today = earliestDate(99, centerTz(c)); // tomorrow in center time: start of the calendar
  const data = {
    lang, locale: LOCALES[lang], sep: SEP[lang] ?? ",", max: MAX_DIVERS, maxItems: MAX_ITEMS,
    payments: !!key, multi, slug, ref, init, products: views,
    now: plusDays(today, -1), maxDate: plusDays(today, 180), closed: closedDates(c), full: fullDates(c, today), taken,
    s: {
      diver: t.diver, divers: t.divers, chooseDate: t.chooseDate, chooseActivity: t.chooseActivity, chooseSlot: t.chooseSlot,
      tooSoon: t.tooSoon("{d}"), tooFar: t.tooFar(assistant), notOpen: t.notOpen, dayFull: t.dayFull, slotFull: t.slotFull, noPay: t.noPay(assistant),
      opening: t.opening, wrong: t.wrong, noConn: t.noConn, fixFirst: t.fixFirst, tooMany: t.tooMany,
      groups: t.groups, refreshTip: t.refreshTip, clash: t.clash("{d}", "{a}"), amS: t.amS, pmS: t.pmS,
      choosePrice: t.choosePrice, perDiver: t.perDiver, infoTitle: t.infoTitle,
      info: { dives: t.infoDives, depth: t.infoDepth, duration: t.infoDuration, level: t.infoFor, inc: t.infoInc, not: t.infoNot, bring: t.infoBring, checkIn: t.checkIn },
      bringDefault: t.bringText, groupNote: t.groupNote, group: t.group(assistant),
      diversLabel: t.diversLabel, less: t.less, more: t.more, date: t.date, startDate: t.startDate,
      slotLabel: t.slotLabel, am: t.am, pm: t.pm, day: t.day, daysN: t.days("{n}"),
      done: t.done, edit: t.edit, remove: t.remove, bookingN: t.bookingN("{n}"), depositWord: t.depositWord,
      overviewEmpty: t.overviewEmpty, overlap: t.overlap("{d}"), prevMonth: t.prevMonth, nextMonth: t.nextMonth,
      totalFor: t.totalFor, totalAll: t.totalAll,
    },
  };

  if (!views.length) return closedPage(c, products[0] || {}, lang);

  return `
${testMode ? `<p class="testmode">${esc(t.testmode)}</p>` : ""}
<header class="center${photo ? " has-photo" : ""}">
  ${photo ? `<div class="photo" style="background-image:url('${esc(photo)}')" role="img" aria-label="${esc(centerName)}"></div>` : ""}
  <div class="hrow">
    ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(centerName)} logo">` : ""}
    <div>
      <p class="center-name">${esc(centerName)}</p>
      ${island ? `<p class="island">${esc(island)}</p>` : ""}
      ${rating ? `<p class="rating"><a href="${esc(mapUrl(c, centerName, island))}" target="_blank" rel="noopener"><span aria-hidden="true">★</span> ${esc(String(rating).replace(".", lang === "en" ? "." : ","))}${reviews ? ` · ${esc(t.reviews(thb(reviews, lang)))}` : ""}</a></p>` : ""}
    </div>
    ${langMenu(lang)}
  </div>
  <p class="via"><span aria-hidden="true">🔒</span> ${esc(t.via)}</p>
</header>

<div class="layout">
<div class="top">
  <h1>${esc(t.pageTitle)}</h1>
  ${unknown.map((n) => `<p class="warn">${esc(t.unknown(n))}</p>`).join("")}
  <div id="items"></div>
  <button type="button" id="another" class="another" hidden><span aria-hidden="true">＋</span> ${esc(t.another)}</button>
</div>

<div class="bottom">
  <p id="choose" class="hint choose">${esc(t.choosePrice)}</p>
  <section class="slate" id="pay" aria-label="${esc(t.payNow)}" hidden>
    <div class="above">
      <div id="lines"></div>
      <div class="row total"><span>${esc(t.totalAll)}</span><span><b id="total">0</b> THB</span></div>
      <div class="row now"><span>${esc(t.payNow)}</span><span><b id="deposit">0</b> THB</span></div>
    </div>
    <svg class="waterline" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 12 C 50 2, 100 22, 150 12 S 250 2, 300 12 S 380 20, 400 12 V24 H0Z"/>
    </svg>
    <div class="below">
      <div class="row"><span>${esc(t.payShop)}</span><span><b id="balance">0</b> THB</span></div>
      <p class="fine">${esc(t.never)}</p>
    </div>
  </section>

  <div class="field">
    <label for="note">${esc(t.noteLabel)}</label>
    <textarea id="note" maxlength="300" rows="2" placeholder="${esc(t.notePh)}"></textarea>
  </div>

  <section class="policy" aria-label="${esc(t.policyTitle)}">
    <p class="policy-title">${esc(t.policyTitle)}</p>
    <ul>${t.policy.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  </section>

  <div id="overlap" class="warn" role="status" hidden></div>
  <div id="payb" hidden>
    <button type="button" id="book" class="book">${esc(t.btn[0])}<span id="btn-amount">0</span>${esc(t.btn[1])}</button>
    <p id="msg" class="msg" role="status" hidden></p>
    <p class="terms"><span class="lock" aria-hidden="true">🔒</span> ${esc(t.secure)} ${esc(t.terms[0])}<a href="${termsUrl(lang)}" target="_blank" rel="noopener">${esc(t.terms[1])}</a></p>
  </div>

  ${meeting ? `<dl class="practical small">
    <div><dt>${esc(t.meeting)}</dt><dd>${esc(meeting)}${mapLink(c, centerName, island, t)}</dd></div>
  </dl>` : ""}
  ${chat ? `<p class="ask">${esc(t.askFirst(assistant))} <a href="${esc(chat)}">${esc(t.backToChat)}</a></p>` : ""}
</div>
</div>

<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>${BOOK_JS}</script>`;
}

// Browser code of the booking page (plain string: no template literals inside).
const BOOK_JS = String.raw`
(() => {
  const d = JSON.parse(document.getElementById("data").textContent);
  const s = d.s;
  const $ = (id) => document.getElementById(id);
  const P = {};
  d.products.forEach((p) => { P[p.code] = p; });
  const f = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, d.sep || ",");
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fill = (tpl, k, v) => tpl.split("{" + k + "}").join(v);
  const addDays = (iso, n) => { const x = new Date(iso + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const fmt = (iso, o) => new Date(iso + "T00:00:00Z").toLocaleDateString(d.locale, Object.assign({ timeZone: "UTC" }, o || { weekday: "short", day: "numeric", month: "short" }));
  const hover = window.matchMedia && window.matchMedia("(hover: hover)").matches;
  const KEY = "talay-b:" + d.slug + ":" + (d.ref || "-");
  let uid = 0;
  const mk = (x) => ({ id: ++uid, code: x.code || "", n: x.n || 1, date: x.date || "", slot: x.slot || "", open: true, pick: !x.code, err: "", month: "",
    grp: x.code && P[x.code] ? P[x.code].groups[0] : "" });
  const GROUPS = ["new", "cert", "up"].filter((g) => d.products.some((p) => p.groups.indexOf(g) >= 0));

  // The plan on this phone (same chat link, last 3 days) plus what the link brings, without doubles.
  let items = [], note = "";
  if (d.multi) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (saved && Date.now() - saved.at < 3 * 864e5) {
        items = (saved.items || []).filter((x) => P[x.code]).slice(0, d.maxItems).map(mk);
        note = saved.note || "";
      }
    } catch (e) { /* private mode */ }
  }
  d.init.forEach((x) => {
    const twin = items.find((y) => y.code === x.code && (y.date === x.date || !x.date || !y.date));
    if (twin) { if (!twin.date && x.date) twin.date = x.date; return; }
    if (items.length < d.maxItems) items.push(mk(x));
  });
  if (!items.length) items.push(mk({}));
  // Finished bookings start folded; the first unfinished one is open.
  let opened = false;
  items.forEach((it) => { const ok = !problem(it); it.open = !ok && !opened; if (it.open) opened = true; });
  if (!opened && items.length === 1 && !items[0].code) items[0].open = true;
  $("note").value = note;

  // Steps for the drop-off count in Talay HQ (one visit = this tab).
  const VISIT = (() => {
    const make = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    try { let v = sessionStorage.getItem("talay-visit"); if (!v) { v = make(); sessionStorage.setItem("talay-visit", v); } return v; } catch (e) { return make(); }
  })();
  const stepped = {};
  function step(st) {
    if (stepped[st]) return;
    stepped[st] = 1;
    try { navigator.sendBeacon("/b/step", JSON.stringify({ s: d.slug, v: VISIT, st: st, c: d.ref || "", l: d.lang })); } catch (e) { /* old browser */ }
  }
  step("open");
  if (items.some((x) => x.code)) { step("group"); step("product"); }

  function slotOf(it) { const p = P[it.code]; if (!p) return ""; return p.slot === "CHOOSE" ? it.slot : p.slot; }
  function blocked(p, date) {
    for (let k = 0; k < p.days; k++) if (d.closed.indexOf(addDays(date, k)) >= 0) return true;
    return false;
  }
  // Full: the center closed the day (or the morning/afternoon) in its zone, or the product reached its maximum.
  function slotFull(p, date, slot, n) {
    for (let k = 0; k < p.days; k++) {
      const day = addDays(date, k), f = d.full[day];
      if (f === "DAY" || (f && (slot === f || p.slot === f))) return true;
      const part = p.slot === "CHOOSE" ? slot : "";
      if (p.maxDay && (((d.taken[p.code] || {})[day + "|" + part]) || 0) + n > p.maxDay) return true;
    }
    return false;
  }
  function dayFull(p, date, n) {
    return p.slot === "CHOOSE" ? slotFull(p, date, "AM", n) && slotFull(p, date, "PM", n) : slotFull(p, date, "", n);
  }
  function problem(it) {
    const p = P[it.code];
    if (!p) return s.chooseActivity;
    if (!(it.n >= 1 && it.n <= d.max)) return s.group;
    if (!it.date) return s.chooseDate;
    if (it.date < p.minDate) return fill(s.tooSoon, "d", fmt(p.minDate, { weekday: "long", day: "numeric", month: "long" }));
    if (it.date > d.maxDate) return s.tooFar;
    if (blocked(p, it.date)) return s.notOpen;
    if (dayFull(p, it.date, it.n)) return s.dayFull;
    if (p.slot === "CHOOSE" && it.slot !== "AM" && it.slot !== "PM") return s.chooseSlot;
    if (p.slot === "CHOOSE" && slotFull(p, it.date, it.slot, it.n)) return s.dayFull;
    return "";
  }
  const slotWord = (k) => ({ AM: s.am, PM: s.pm, DAY: s.day }[k] || "");

  // ---- one booking, open ----
  function infoHtml(p) {
    const i = p.info, rows = [];
    const add = (k, v) => { if (v) rows.push("<div><dt>" + esc(s.info[k]) + "</dt><dd>" + esc(v) + "</dd></div>"); };
    add("dives", i.dives); add("depth", i.depth); add("duration", i.duration || (p.days > 1 ? fill(s.daysN, "n", p.days) : ""));
    add("level", i.level); add("inc", i.inc); add("not", i.not); add("bring", i.bring || s.bringDefault); add("checkIn", i.checkIn);
    return '<details class="info"><summary>' + esc(s.infoTitle) + "</summary><dl>" + rows.join("") + "</dl></details>";
  }
  function actCard(p, it) {
    const on = it.code === p.code;
    return '<div class="act' + (on ? " on" : "") + '"><button type="button" class="pick" data-act="' + esc(p.code) + '" aria-pressed="' + on + '">' +
      '<span class="aname">' + esc(p.name) + '</span><span class="aprice">' + f(p.price) + " THB · " + esc(s.perDiver) + "</span></button>" + infoHtml(p) + "</div>";
  }
  function calHtml(it, p) {
    // Open on the month of this booking, else of the bookings above it, never before the first bookable day.
    const near = it.date || items.map((x) => x.date).filter(Boolean).sort().pop() || p.minDate;
    const first = it.month || (near < p.minDate ? p.minDate : near).slice(0, 7);
    const start = new Date(first + "-01T00:00:00Z");
    const lead = (start.getUTCDay() + 6) % 7; // Monday first
    const daysIn = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    const prev = addDays(first + "-01", -1).slice(0, 7), next = addDays(first + "-01", 32).slice(0, 7);
    const canPrev = prev >= p.minDate.slice(0, 7), canNext = next <= d.maxDate.slice(0, 7);
    let h = '<div class="cal" data-cal><div class="calh"><button type="button" data-month="' + prev + '"' + (canPrev ? "" : " disabled") + ' aria-label="' + esc(s.prevMonth) + '">‹</button><b>' +
      esc(fmt(first + "-01", { month: "long", year: "numeric" })) + '</b><button type="button" data-month="' + next + '"' + (canNext ? "" : " disabled") + ' aria-label="' + esc(s.nextMonth) + '">›</button></div><div class="calg">';
    for (let w = 0; w < 7; w++) h += '<span class="wd">' + esc(fmt(addDays("2024-01-01", w), { weekday: "narrow" })) + "</span>";
    for (let k = 0; k < lead; k++) h += "<span></span>";
    const span = it.date && p.days > 1 ? addDays(it.date, p.days - 1) : it.date;
    // The other bookings sit in the same calendar; the day this one clashes on gets an orange border.
    const occ = occupancy(it), hot = clash(it) ? clash(it).day : "";
    for (let day = 1; day <= daysIn; day++) {
      const iso = first + "-" + String(day).padStart(2, "0");
      const off = iso < p.minDate || iso > d.maxDate || blocked(p, iso) || dayFull(p, iso, it.n);
      const e = occ[iso] || [];
      const cls = (iso === it.date ? " sel" : it.date && iso > it.date && iso <= span ? " in" : "") + (off ? " off" : "") + (iso === hot ? " hot" : "");
      h += '<button type="button" class="day' + cls + '" data-day="' + iso + '"' + (off ? ' disabled aria-disabled="true"' : "") + ' aria-label="' + esc(fmt(iso, { weekday: "long", day: "numeric", month: "long" }) + e.map((x) => ", " + x.lbl).join("")) + '"><b>' + day + "</b>" +
        e.map((x) => '<i class="' + x.part + '" aria-hidden="true">' + esc(x.lbl) + "</i>").join("") + "</button>";
    }
    return h + "</div></div>";
  }
  function openHtml(it, i) {
    const p = P[it.code];
    let h = '<section class="item open' + (it.err ? " bad" : "") + '" data-id="' + it.id + '"><div class="ihead"><h2>' + esc(fill(s.bookingN, "n", i + 1)) + "</h2>" +
      (items.length > 1 ? '<button type="button" class="linkbtn" data-remove>' + esc(s.remove) + "</button>" : "") + "</div>";
    if (it.pick || !p) {
      // First who the diver is (three cards, all closed), then the activities of that group.
      h += '<div class="grps" role="group">' + GROUPS.map((g) => '<button type="button" class="grp' + (it.grp === g ? " on" : "") + '" data-grp="' + g + '" aria-pressed="' + (it.grp === g) + '"><b>' +
        esc(s.groups[g][0]) + "</b><span>" + esc(s.groups[g][1]) + "</span></button>").join("") + "</div>";
      if (it.grp) {
        const list = d.products.filter((x) => x.groups.indexOf(it.grp) >= 0);
        h += '<div class="acts">' + list.map((x) => actCard(x, it) + (it.grp === "cert" && x.refresh ? '<p class="tip">' + esc(s.refreshTip) + "</p>" : "")).join("") + "</div>";
      }
    } else {
      h += '<div class="acts">' + actCard(p, it) + '</div><button type="button" class="linkbtn change" data-repick>' + esc(s.edit) + "</button>";
    }
    if (p && !it.pick) {
      h += '<div class="field"><span class="lbl">' + esc(s.diversLabel) + '</span><div class="stepper"><button type="button" data-n="-1" aria-label="' + esc(s.less) + '"' + (it.n <= 1 ? " disabled" : "") + '>−</button><output>' + it.n +
        '</output><button type="button" data-n="1" aria-label="' + esc(s.more) + '"' + (it.n >= d.max ? " disabled" : "") + ">+</button></div>" +
        (p.maxGroup && it.n > p.maxGroup ? '<p class="note-orange">' + esc(s.groupNote) + "</p>" : "") +
        (it.n >= d.max ? '<p class="hint">' + esc(s.group) + "</p>" : "") + "</div>";
      h += '<div class="field"><span class="lbl">' + esc(p.days > 1 ? s.startDate : s.date) +
        (it.date ? ' <span class="chosen">' + esc(fmt(it.date, { weekday: "long", day: "numeric", month: "long" })) + (p.days > 1 ? " → " + esc(fmt(addDays(it.date, p.days - 1))) : "") + "</span>" : "") + "</span>" + calHtml(it, p) +
        (clash(it) ? '<p class="note-orange" role="status">' + esc(clashText(clash(it))) + "</p>" : "") + "</div>";
      if (p.slot === "CHOOSE") {
        h += '<div class="field"><span class="lbl">' + esc(s.slotLabel) + '</span><div class="slots">' +
          ["AM", "PM"].map((k) => {
            const no = !!it.date && slotFull(p, it.date, k, it.n);
            return '<button type="button" data-slot="' + k + '" aria-pressed="' + (it.slot === k) + '" class="' + (it.slot === k ? "on" : "") + '"' + (no ? " disabled" : "") + ">" + esc(slotWord(k)) + (no ? " · " + esc(s.slotFull) : "") + "</button>";
          }).join("") + "</div></div>";
      } else if (p.slot) {
        h += '<p class="hint slotfix">' + esc(slotWord(p.slot)) + (p.days > 1 ? " · " + esc(fill(s.daysN, "n", p.days)) : "") + "</p>";
      }
      const pr = problem(it);
      h += (it.err ? '<p class="error" role="alert">' + esc(it.err) + "</p>" : "") + '<button type="button" class="done" data-done' + (pr ? " disabled" : "") + ">" + esc(s.done) + "</button>" +
        (pr && !it.err ? '<p class="hint">' + esc(pr) + "</p>" : "");
    } else if (it.err) {
      h += '<p class="error" role="alert">' + esc(it.err) + "</p>";
    }
    return h + "</section>";
  }
  // A course of several days: "30–31 Oct", else "30 Oct".
  function span(iso, days) {
    const dm = (x) => fmt(x, { day: "numeric", month: "short" });
    if (!(days > 1)) return dm(iso);
    const end = addDays(iso, days - 1);
    return iso.slice(0, 7) === end.slice(0, 7) && /^\d/.test(dm(iso)) ? String(Number(iso.slice(8))) + (d.lang === "de" ? "." : "") + "–" + dm(end) : dm(iso) + " – " + dm(end);
  }
  // Two bookings on the same day and the same part of it (or one takes the whole day).
  function parts(it) {
    const p = P[it.code];
    if (!p || !it.date) return [];
    const k = slotOf(it), part = p.days > 1 || k === "DAY" ? "day" : k === "AM" ? "am" : k === "PM" ? "pm" : "any";
    const out = [];
    for (let j = 0; j < p.days; j++) out.push({ day: addDays(it.date, j), part: part });
    return out;
  }
  function clash(it) {
    const mine = parts(it);
    for (const o of items) {
      if (o === it) continue;
      for (const a of mine) for (const b of parts(o)) {
        if (a.day === b.day && (a.part === "day" || b.part === "day" || a.part === b.part)) return { day: a.day, other: o, part: b.part };
      }
    }
    return null;
  }
  function clashText(c) {
    const w = { day: s.day, am: s.am, pm: s.pm }[c.part];
    const what = P[c.other.code].name + (w ? " (" + (d.lang === "de" ? w : w.toLowerCase()) + ")" : "");
    return fill(fill(s.clash, "d", fmt(c.day, { weekday: "short", day: "numeric", month: "short" })), "a", what);
  }

  // ---- one booking, folded to one line ----
  function lineText(it) {
    const p = P[it.code];
    if (!p) return s.chooseActivity;
    return [it.n + " p", p.name, it.date ? span(it.date, p.days) : "", slotWord(slotOf(it)), f(p.deposit * it.n) + " THB " + s.depositWord].filter(Boolean).join(" · ");
  }
  function lineHtml(it) {
    return '<section class="item line' + (it.err ? " bad" : "") + '" data-id="' + it.id + '"><button type="button" class="lbtn" data-edit><span>' + esc(lineText(it)) + '</span><span class="pen">' + esc(s.edit) + "</span></button>" +
      '<button type="button" class="x" data-remove aria-label="' + esc(s.remove) + '">×</button>' + (it.err ? '<p class="error">' + esc(it.err) + "</p>" : "") +
      (!it.err && clash(it) && !clash(it).other.open ? '<p class="lwarn">' + esc(clashText(clash(it))) + "</p>" : "") + "</section>";
  }

  // ---- the other bookings per day, for the calendar of the open one ----
  function occupancy(skip) {
    const occ = {};
    items.forEach((it) => {
      const p = P[it.code];
      if (it === skip || !p || !it.date) return;
      const k = slotOf(it), lbl = p.short + (p.days > 1 ? "" : k === "AM" ? " " + s.amS : k === "PM" ? " " + s.pmS : "");
      for (let j = 0; j < p.days; j++) {
        const day = addDays(it.date, j);
        (occ[day] = occ[day] || []).push({ lbl: lbl, part: p.days > 1 || k === "DAY" ? "full" : k === "AM" ? "am" : k === "PM" ? "pm" : "any" });
      }
    });
    return occ;
  }
  // Every clash once, for the bottom of the page (after "Done").
  function clashes() {
    const seen = {}, out = [];
    items.forEach((it) => {
      if (it.open) return;
      const c = clash(it);
      if (!c || c.other.open) return;
      const k = c.day + [it.id, c.other.id].sort().join("-");
      if (seen[k]) return;
      seen[k] = 1;
      out.push(clashText(c));
    });
    return out;
  }

  function totals() {
    let total = 0, dep = 0;
    const lines = [];
    items.forEach((it) => {
      const p = P[it.code];
      if (!p) return;
      total += p.price * it.n; dep += p.deposit * it.n;
      lines.push('<div class="row sub"><span>' + esc(it.n + " × " + p.name) + "</span><span>" + f(p.deposit * it.n) + " THB " + esc(s.depositWord) + "</span></div>");
    });
    // Nothing chosen yet: no total of 0 THB and no pay button.
    const any = items.some((x) => P[x.code]);
    $("pay").hidden = !any; $("payb").hidden = !any;
    $("choose").hidden = any;
    $("lines").innerHTML = lines.join("");
    $("total").textContent = f(total);
    $("deposit").textContent = f(dep);
    $("btn-amount").textContent = f(dep);
    $("balance").textContent = f(total - dep);
  }
  function save() {
    if (!d.multi) return;
    try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), note: $("note").value, items: items.filter((x) => x.code).map((x) => ({ code: x.code, n: x.n, date: x.date, slot: x.slot })) })); } catch (e) { /* private mode */ }
  }

  function render() {
    $("items").innerHTML = items.map((it, i) => (it.open ? openHtml(it, i) : lineHtml(it))).join("");
    const ov = clashes();
    $("overlap").hidden = !ov.length;
    $("overlap").innerHTML = ov.map((x) => "<p>" + esc(x) + "</p>").join("");
    $("another").hidden = !d.multi || items.length >= d.maxItems;
    totals();
    save();
    if (hover) document.querySelectorAll("#items details.info").forEach((det) => {
      det.addEventListener("mouseenter", () => { if (!det.dataset.pin) det.open = true; });
      det.addEventListener("mouseleave", () => { if (!det.dataset.pin) det.open = false; });
      det.querySelector("summary").addEventListener("click", (e) => { e.preventDefault(); det.dataset.pin = det.dataset.pin ? "" : "1"; det.open = !!det.dataset.pin; });
    });
  }
  // Close finished open bookings; returns the first one that still has a problem.
  function settle(markErrors) {
    let bad = null;
    items.forEach((it) => {
      if (!it.open) return;
      const pr = problem(it);
      if (!pr) { it.open = false; it.err = ""; it.pick = false; }
      else if (markErrors) { it.err = pr; bad = bad || it; }
      else if (!bad) bad = it;
    });
    return bad;
  }
  function focusItem(it) {
    const el = document.querySelector('[data-id="' + it.id + '"]');
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("items").addEventListener("click", (e) => {
    const sec = e.target.closest("[data-id]");
    if (!sec) return;
    const it = items.find((x) => String(x.id) === sec.dataset.id);
    const b = e.target.closest("button");
    if (!it || !b) return;
    $("msg").hidden = true;
    if (b.dataset.grp) { it.grp = b.dataset.grp; step("group"); }
    else if (b.dataset.act) {
      if (it.code !== b.dataset.act) { it.code = b.dataset.act; it.slot = ""; it.month = ""; if (it.date && it.date < P[it.code].minDate) it.date = ""; }
      it.pick = false; it.err = ""; step("product");
    } else if (b.hasAttribute("data-repick")) { it.pick = true; }
    else if (b.dataset.n) { it.n = Math.min(Math.max(it.n + Number(b.dataset.n), 1), d.max); }
    else if (b.dataset.month) { it.month = b.dataset.month; }
    else if (b.dataset.day) {
      it.date = b.dataset.day; it.err = "";
    }
    else if (b.dataset.slot) { it.slot = b.dataset.slot; it.err = ""; }
    else if (b.hasAttribute("data-done")) {
      const pr = problem(it);
      it.err = pr;
      if (!pr) { it.open = false; step("done"); }
    } else if (b.hasAttribute("data-edit")) {
      settle(false);
      it.open = true;
    } else if (b.hasAttribute("data-remove")) {
      items = items.filter((x) => x !== it);
      if (!items.length) items.push(mk({}));
    } else return;
    render();
    if (b.hasAttribute("data-edit") || b.hasAttribute("data-done")) focusItem(it);
  });
  $("another").onclick = () => {
    const bad = settle(true);
    if (bad) { render(); focusItem(bad); return; }
    if (items.length >= d.maxItems) return;
    const it = mk({});
    items.push(it);
    render();
    focusItem(it);
  };
  $("note").addEventListener("input", save);

  $("book").onclick = () => {
    const msg = $("msg");
    const bad = settle(true);
    render();
    if (bad) {
      msg.hidden = false; msg.textContent = items.length > 1 ? s.fixFirst : bad.err;
      focusItem(bad);
      return;
    }
    msg.hidden = false;
    if (!d.payments) { msg.textContent = s.noPay; return; }
    const btn = $("book");
    btn.disabled = true;
    step("pay");
    msg.textContent = s.opening;
    fetch("/b/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: d.slug, ref: d.ref, lang: d.lang, note: $("note").value.slice(0, 300),
        items: items.map((it) => ({ code: it.code, date: it.date, slot: slotOf(it) === "AM" || slotOf(it) === "PM" ? slotOf(it) : "", divers: it.n })) }),
    })
      .then((r) => r.json())
      .then((r) => {
        if (r.url) { window.location.href = r.url; return; }
        msg.textContent = r.error || s.wrong;
        btn.disabled = false;
      })
      .catch(() => { msg.textContent = s.noConn; btn.disabled = false; });
  };
  render();
})();
`;

function fmtDate(iso, lang = "en") {
  return new Date(iso + "T00:00:00Z").toLocaleDateString(LOCALES[lang] || "en-GB",
    { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
// One day: "Friday 30 October". A course of several days: "30–31 October" or "30 October – 2 November".
function fmtDays(iso, days, lang = "en") {
  if (!(days > 1) || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return fmtDate(iso, lang);
  const end = plusDays(iso, days - 1);
  const dm = (x) => new Date(x + "T00:00:00Z").toLocaleDateString(LOCALES[lang] || "en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const day = (x) => String(Number(x.slice(8)));
  return iso.slice(0, 7) === end.slice(0, 7) && /^\d/.test(dm(iso)) ? `${day(iso)}${lang === "de" ? "." : ""}–${dm(end)}` : `${dm(iso)} – ${dm(end)}`;
}
// Booking number of one order (one Stripe payment), the same everywhere: "T-7K4M2Q".
async function orderRef(sessionId) {
  const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(sessionId))));
  const abc = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return "T-" + Array.from(buf.slice(0, 6), (b) => abc[b % 32]).join("");
}

// A product switched off in the customer zone (Products → Active) can't be booked online.
const CLOSED = {
  en: { title: "Online booking is closed for now", text: (a) => `Send ${a} a message in your chat and we'll help you further.` },
  nl: { title: "Online boeken is even niet mogelijk", text: (a) => `Stuur ${a} een bericht in je chat, dan helpen we je verder.` },
  fr: { title: "La réservation en ligne est fermée pour le moment", text: (a) => `Envoyez un message à ${a} dans votre conversation et nous vous aiderons.` },
  de: { title: "Online-Buchung ist gerade geschlossen", text: (a) => `Schreib ${a} eine Nachricht im Chat, dann helfen wir dir weiter.` },
  es: { title: "La reserva online está cerrada por ahora", text: (a) => `Envía un mensaje a ${a} en el chat y te ayudamos.` },
};
function closedPage(c, p, lang) {
  const t = CLOSED[lang] || CLOSED.en;
  const name = tr(p, "Name", lang).v || first(p["Name"]) || "";
  const assistant = first(c["Assistant name"]) || first(c["Name"]) || "us";
  return `<main class="empty"><h1>${esc(t.title)}</h1><p>${esc(name)}</p><p>${esc(t.text(assistant))}</p></main>`;
}

// Language menu on the booking page: reloads the same page with ?l=, so product, ref and checkout follow it
// (window.URL: inside an inline handler, plain URL means document.URL)
const LANG_LABEL = { en: "Language", fr: "Langue", de: "Sprache", es: "Idioma", nl: "Taal" };
function langMenu(lang) {
  const opts = LANGS.map((l) => `<option value="${l}"${l === lang ? " selected" : ""}>${l.toUpperCase()}</option>`).join("");
  return `<select class="lang" aria-label="${LANG_LABEL[lang]}" onchange="var u=new window.URL(location.href);u.searchParams.set('l',this.value);location.href=u">${opts}</select>`;
}

function notFound(lang) {
  const t = T[lang];
  return `<main class="empty"><h1>${esc(t.notFoundTitle)}</h1>
  <p>${esc(t.notFoundText)}</p></main>`;
}
function problem(text, lang) {
  return `<main class="empty"><h1>${esc(T[lang].problemTitle)}</h1><p>${esc(text)}</p></main>`;
}

function page(body, status = 200, lang = "en", title = "", wide = false, theme = "") {
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title || T[lang].title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "d3d4dd17ea1747cbaac3011aa000a493"}'></script><!-- End Cloudflare Web Analytics -->
</head>
<body${theme ? ` class="${theme}"` : ""}><div class="wrap${wide ? " wide" : ""}">${body}</div></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Vary": "Accept-Language" },
  });
}

const CSS = `
:root{--deep:#09262F;--shelf:#163741;--ridge:#28505D;--on-deep:#C9D6D9;--sand:#DCA44A;--sand-wash:#F1E6CF;--shore:#F7F3EA;--line:#DDD5C6;--ink:#09262F;--muted:#4E646C}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{overflow-x:hidden}
body{margin:0;background:var(--shore);color:var(--ink);font:400 17px/1.55 "Schibsted Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:30rem;margin:0 auto;padding:1rem 1rem 3rem}
.center{display:flex;align-items:center;gap:.85rem;margin-bottom:2rem;padding:1rem;border-radius:16px;background:radial-gradient(320px 160px at 100% 0%,#1C5262 0%,transparent 70%),var(--deep);color:var(--shore)}
.logo{width:52px;height:52px;object-fit:contain;border-radius:12px;background:#fff;border:1px solid var(--ridge)}
.center-name{margin:0;font-weight:700;font-size:1.1rem;letter-spacing:-.01em}
.island{margin:0;color:var(--sand);font-size:.9rem;font-weight:500}
.lang{margin-left:auto;align-self:flex-start;-webkit-appearance:none;appearance:none;font:inherit;font-size:.85rem;font-weight:600;color:var(--shore);padding:.35rem 1.7rem .35rem .7rem;border:1px solid var(--ridge);border-radius:999px;background:transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23C9D6D9' stroke-width='1.6'/%3E%3C/svg%3E") no-repeat right .65rem center;cursor:pointer}
.lang:hover{border-color:var(--on-deep)}
.lang option{color:var(--deep);background:var(--shore)}
.lang:focus-visible{outline:3px solid var(--sand);outline-offset:2px}
h1{font-size:2.1rem;line-height:1.08;letter-spacing:-.035em;margin:0 0 .6rem;font-weight:700}
.intro{margin:0 0 2rem;color:var(--muted)}
.intro strong{color:var(--ink);font-weight:600}
.field{margin-bottom:1.5rem}
label,#divers-label{display:block;font-weight:600;margin-bottom:.4rem}
input[type=date]{-webkit-appearance:none;appearance:none;display:block;min-width:0;max-width:100%;text-align:left;width:100%;font:inherit;color:inherit;padding:.75rem .9rem;border:1px solid var(--line);border-radius:10px;background:#fff;min-height:3rem}
input[type=date]:focus-visible,.stepper button:focus-visible,.book:focus-visible{outline:3px solid var(--sand);outline-offset:2px}
input[type=date].invalid{border-color:#B3261E;background:#FFF5F4}
input[type=date]::-webkit-date-and-time-value{text-align:left}
.error{margin:.5rem 0 0;color:#B3261E;font-weight:600;font-size:.95rem}
.hint{margin:.4rem 0 0;font-size:.85rem;color:var(--muted)}
.stepper{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:#fff;overflow:hidden}
.stepper button{width:3rem;height:3rem;border:0;background:none;font:inherit;font-size:1.4rem;color:var(--deep);cursor:pointer}
.stepper button:hover:not(:disabled){background:var(--sand-wash)}
.stepper button:disabled{color:var(--line);cursor:default}
.stepper output{min-width:2.5rem;text-align:center;font-weight:700;font-size:1.1rem}
.slate{margin:2rem 0 1.25rem;border-radius:16px;overflow:hidden;border:1px solid var(--line)}
.slate .above{background:var(--sand-wash);padding:1.1rem 1.2rem .4rem}
.slate .below{background:var(--deep);color:var(--shore);padding:.2rem 1.2rem 1.1rem;margin-top:-1px}
.waterline{display:block;width:100%;height:18px;background:var(--sand-wash)}
.waterline path{fill:var(--deep)}
.row{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;padding:.3rem 0}
.row>span:last-child{white-space:nowrap;text-align:right}
.row b{font-weight:700}
.total{color:var(--muted);font-size:.95rem}
.now{font-size:1.1rem}
.now b{font-size:1.5rem}
.fine{margin:.35rem 0 0;font-size:.82rem;color:var(--on-deep)}
.book{width:100%;min-height:3.4rem;border:0;border-radius:999px;background:var(--sand);color:var(--deep);font:inherit;font-weight:700;font-size:1.05rem;cursor:pointer}
.book:hover{background:var(--deep);color:var(--shore)}
.book:disabled{opacity:.6;cursor:default}
.book.danger{background:#fff;color:#B3261E;border:1px solid #E3B3AE}
.book.danger:hover{background:#FFF5F4}
.warn{margin:0;padding:.8rem 1rem;border-radius:10px;background:var(--sand-wash);color:#6B4A00;font-size:.95rem}
.testmode{margin:0 0 1rem;padding:.5rem .8rem;border-radius:8px;background:var(--sand-wash);color:#6B4A00;font-size:.85rem;font-weight:600}
.terms{margin:.8rem 0 0;font-size:.82rem;text-align:center;color:var(--muted)}
.terms a{color:inherit;text-underline-offset:3px}
.msg{margin:.9rem 0 0;padding:.8rem 1rem;border-radius:10px;background:var(--sand-wash);font-size:.95rem}
.practical{margin:2.25rem 0 0;padding-top:1.25rem;border-top:1px solid var(--line);display:grid;gap:.8rem}
.practical div{display:grid;grid-template-columns:7.5rem 1fr;gap:.75rem}
.practical dt{color:var(--muted)}
.practical dd{margin:0}
.practical a.map{font-size:.9rem;color:var(--deep);font-weight:600;text-decoration-color:var(--sand);text-decoration-thickness:2px;text-underline-offset:3px}
.policy{margin:0 0 1rem;padding:.85rem 1rem;border:1px solid var(--line);border-radius:12px;background:#fff;font-size:.9rem}
.policy-title{margin:0 0 .3rem;font-weight:600}
.policy ul{margin:0;padding-left:1.1rem;color:var(--muted)}
.policy li::marker{color:var(--sand)}
.policy li+li{margin-top:.2rem}
.lock{font-size:.75rem}
.ask{margin:1.5rem 0 0;font-size:.9rem;color:var(--muted)}
.ask a{color:var(--deep);font-weight:600;text-decoration-color:var(--sand);text-decoration-thickness:2px;text-underline-offset:3px}
h2.next{font-size:1.15rem;letter-spacing:-.01em;margin:2.25rem 0 .5rem}
.course{margin:0;color:var(--muted)}
h2.next+.practical,.course+.practical{margin-top:1rem;padding-top:0;border-top:0}
a.book.chat{display:flex;align-items:center;justify-content:center;text-decoration:none;margin-top:1rem}
.empty{padding-top:3rem}
.empty h1{font-size:1.6rem}
.empty p{color:var(--muted)}
.booked{margin:0 0 1.5rem;padding-left:1.1rem;color:var(--muted)}
.booked strong{color:var(--ink)}
.booked li+li{margin-top:.3rem}
.booked li::marker{color:var(--sand)}
/* Booking page with several bookings (talay.io/b/[slug]) */
.wrap.wide{max-width:38rem}
.center{flex-wrap:wrap;position:relative;overflow:hidden}
.center .hrow{display:flex;align-items:center;gap:.85rem;width:100%;position:relative}
.center.has-photo{padding-top:7.5rem}
.center .photo{position:absolute;inset:0 0 auto 0;height:9rem;background-size:cover;background-position:center}
.center .photo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(9,38,47,0) 35%,var(--deep) 100%)}
.rating{margin:.15rem 0 0;font-size:.85rem}
.rating a{color:var(--on-deep);text-decoration:none}
.rating a span{color:var(--sand)}
.rating a:hover{color:var(--shore)}
.via{margin:.7rem 0 0;width:100%;font-size:.78rem;color:var(--on-deep);position:relative}
.layout{display:grid;grid-template-columns:minmax(0,1fr);gap:0 2.5rem}
.item{border:1px solid var(--line);border-radius:16px;background:#fff;margin-bottom:.8rem}
.item.open{padding:1rem 1.1rem 1.2rem}
.item.bad{border-color:#B3261E}
.ihead{display:flex;justify-content:space-between;align-items:baseline;gap:1rem}
.ihead h2{font-size:1.05rem;margin:0 0 .4rem;letter-spacing:-.01em}
.linkbtn{border:0;background:none;padding:.2rem 0;font:inherit;font-size:.88rem;font-weight:600;color:var(--muted);cursor:pointer;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
.linkbtn:hover{color:var(--ink);text-decoration-color:var(--sand)}
.linkbtn.change{margin:.1rem 0 .4rem}
.glabel{margin:.9rem 0 .4rem;font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.acts{display:grid;gap:.5rem}
.act{border:1px solid var(--line);border-radius:12px;background:var(--shore)}
.act.on{border-color:var(--deep);background:#fff;box-shadow:inset 0 0 0 1px var(--deep)}
.pick{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;width:100%;border:0;background:none;padding:.75rem .9rem .3rem;font:inherit;color:inherit;text-align:left;cursor:pointer}
.pick:focus-visible,.day:focus-visible,.slots button:focus-visible,.another:focus-visible,.lbtn:focus-visible{outline:3px solid var(--sand);outline-offset:2px}
.aname{font-weight:600}
.aprice{white-space:nowrap;font-size:.88rem;color:var(--muted)}
.info{padding:0 .9rem .6rem}
.info summary{display:inline-block;cursor:pointer;font-size:.85rem;font-weight:600;color:var(--deep);text-decoration:underline;text-decoration-color:var(--sand);text-decoration-thickness:2px;text-underline-offset:3px;list-style:none}
.info summary::-webkit-details-marker{display:none}
.info summary::after{content:" +";color:var(--sand)}
.info[open] summary::after{content:" −"}
.info dl{margin:.5rem 0 .2rem;display:grid;gap:.3rem;font-size:.88rem}
.info dl div{display:grid;grid-template-columns:7rem 1fr;gap:.6rem}
.info dt{color:var(--muted)}
.info dd{margin:0}
.item .field{margin:1.1rem 0 0}
.lbl{display:block;font-weight:600;margin-bottom:.4rem}
.chosen{font-weight:400;color:var(--muted)}
.note-orange{margin:.6rem 0 0;padding:.65rem .85rem;border-radius:10px;background:#FFF0DC;border:1px solid #F0C27A;color:#7A4A00;font-size:.92rem}
.cal{max-width:21rem;border:1px solid var(--line);border-radius:12px;padding:.5rem;background:#fff}
.calh{display:flex;justify-content:space-between;align-items:center;margin-bottom:.3rem}
.calh b{font-weight:600;text-transform:capitalize}
.calh button{width:2.2rem;height:2.2rem;border:0;border-radius:999px;background:none;font-size:1.3rem;color:var(--deep);cursor:pointer}
.calh button:hover:not(:disabled){background:var(--sand-wash)}
.calh button:disabled{color:var(--line);cursor:default}
.calg{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}
.calg .wd{font-size:.72rem;color:var(--muted);padding:.2rem 0;text-transform:uppercase}
.day{height:2.4rem;border:0;border-radius:8px;background:none;font:inherit;font-size:.92rem;color:var(--ink);cursor:pointer}
.day:hover:not(:disabled){background:var(--sand-wash)}
.day.off{color:#B9B2A5;background:repeating-linear-gradient(135deg,transparent 0 5px,#F1EDE4 5px 6px);cursor:default}
.day.sel,.day.sel:hover:not(:disabled){background:var(--deep);color:var(--shore);font-weight:700}
.day.in,.day.in:hover:not(:disabled){background:var(--ridge);color:var(--shore)}
.slots{display:flex;gap:.5rem;flex-wrap:wrap}
.slots button{min-height:2.6rem;padding:0 1.1rem;border:1px solid var(--line);border-radius:999px;background:#fff;font:inherit;font-weight:600;color:var(--ink);cursor:pointer}
.slots button.on{background:var(--deep);border-color:var(--deep);color:var(--shore)}
.slots button:disabled{opacity:.45;cursor:not-allowed;text-decoration:line-through}
.slotfix{margin-top:.8rem}
.done{margin-top:1.2rem;min-height:2.8rem;padding:0 1.6rem;border:0;border-radius:999px;background:var(--deep);color:var(--shore);font:inherit;font-weight:700;cursor:pointer}
.done:hover{background:var(--ridge)}
.item.line{display:flex;align-items:center;flex-wrap:wrap}
.lbtn{flex:1;display:flex;justify-content:space-between;gap:1rem;align-items:center;min-height:3.2rem;border:0;background:none;padding:.6rem .4rem .6rem 1rem;font:inherit;font-size:.95rem;color:var(--ink);text-align:left;cursor:pointer}
.lbtn .pen{font-size:.82rem;font-weight:600;color:var(--muted);white-space:nowrap}
.lbtn:hover .pen{color:var(--ink)}
.x{width:2.8rem;height:2.8rem;margin-right:.3rem;border:0;border-radius:999px;background:none;font-size:1.4rem;color:var(--muted);cursor:pointer}
.x:hover{background:#FFF5F4;color:#B3261E}
.item.line .error{width:100%;margin:0 1rem .7rem}
.another{display:flex;align-items:center;justify-content:center;gap:.4rem;width:100%;min-height:3rem;border:1.5px dashed var(--ridge);border-radius:14px;background:none;font:inherit;font-weight:700;color:var(--deep);cursor:pointer}
.another:hover{background:var(--sand-wash);border-style:solid}
.another[hidden],#overlap[hidden]{display:none}
#overlap{margin-top:.8rem}
#overlap p{margin:0}
#overlap p+p{margin-top:.35rem}
.row.sub{font-size:.88rem;color:var(--muted);padding:.1rem 0}
textarea{display:block;width:100%;font:inherit;color:inherit;padding:.7rem .9rem;border:1px solid var(--line);border-radius:10px;background:#fff;resize:vertical}
textarea:focus-visible{outline:3px solid var(--sand);outline-offset:2px}
.practical.small{font-size:.85rem;gap:.5rem}
.practical.small div{grid-template-columns:6.5rem 1fr}
.bottom .slate{margin-top:1.6rem}
/* Round 2: groups, clash notes, bigger plan */
.grps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem;margin:.2rem 0 .8rem}
.grp{display:flex;flex-direction:column;gap:.25rem;align-items:flex-start;text-align:left;min-height:5.2rem;padding:.8rem .85rem;border:1px solid var(--line);border-radius:14px;background:var(--shore);font:inherit;color:inherit;cursor:pointer}
.grp b{font-size:.98rem;line-height:1.2}
.grp span{font-size:.8rem;line-height:1.3;color:var(--muted)}
.grp.on{border:2px solid var(--sand);padding:calc(.8rem - 1px) calc(.85rem - 1px)}
.grp:focus-visible{outline:3px solid var(--sand);outline-offset:2px}
.tip{margin:-.15rem 0 .2rem .2rem;font-size:.85rem;color:var(--muted)}
.lwarn{width:100%;margin:0 1rem .7rem;font-size:.85rem;color:#7A4A00}
.done:disabled{opacity:.4;cursor:not-allowed}
.done:disabled:hover{background:var(--deep)}
.choose{margin:1.6rem 0 0}
.oref{margin:-.2rem 0 1rem;color:var(--muted)}
.oref b{color:var(--ink);letter-spacing:.04em}
.bottom #overlap{margin:0 0 1rem}
.cal{max-width:32rem}
.day{height:auto;min-height:3.3rem;padding:4px 2px;display:flex;flex-direction:column;align-items:stretch;gap:2px;min-width:0}
.day b{font-weight:inherit}
.day i{display:block;font-style:normal;font-size:.62rem;font-weight:600;line-height:1.3;border-radius:3px;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#DCEBEE;color:var(--deep)}
.day i.full{background:var(--deep);color:var(--shore)}
.day.hot{box-shadow:inset 0 0 0 2px #E8963A}
@media (min-width:600px){.day i{font-size:.68rem}}
@media (max-width:480px){.grps{gap:.35rem}.grp{padding:.65rem .6rem;min-height:4.8rem}.grp b{font-size:.88rem}.grp span{font-size:.74rem}}

/* Underwater style (booking page and thanks page): teal at the top, navy at the bottom, so the page gets
   darker as you scroll; light rays and a thin wave only at the top. Text stays high contrast. */
body.sea{position:relative;min-height:100vh;color:#F7F3EA;background:linear-gradient(180deg,#1C6E7D 0%,#155868 30%,#0F4655 60%,#09262F 88%) #09262F}
body.sea::before{content:"";position:absolute;left:0;right:0;top:0;height:640px;pointer-events:none;background:repeating-linear-gradient(110deg,rgba(255,255,255,0) 0 70px,rgba(255,255,255,.07) 70px 110px,rgba(255,255,255,0) 110px 190px,rgba(255,255,255,.05) 190px 210px,rgba(255,255,255,0) 210px 300px);-webkit-mask-image:linear-gradient(180deg,#000 0%,transparent 100%);mask-image:linear-gradient(180deg,#000 0%,transparent 100%)}
body.sea::after{content:"";position:absolute;left:0;right:0;top:0;height:12px;pointer-events:none;opacity:.55;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='12'%3E%3Cpath d='M0 6 C 20 0, 40 12, 60 6 S 100 0, 120 6' fill='none' stroke='%23F7F3EA' stroke-width='1'/%3E%3C/svg%3E") repeat-x}
.sea .wrap{position:relative;z-index:1}
.sea .testmode{background:rgba(220,164,74,.18);color:#F3D9A8}
.sea .center{background:rgba(9,38,47,.42);border:1px solid rgba(247,243,234,.12)}
.sea .center .photo::after{background:linear-gradient(180deg,rgba(9,38,47,0) 35%,rgba(9,38,47,.9) 100%)}
.sea .item{background:rgba(247,243,234,.08);border-color:rgba(247,243,234,.16);color:#F7F3EA}
.sea .item.bad{border-color:#FF9B8F}
.sea .linkbtn{color:#C9D6D9;text-decoration-color:rgba(247,243,234,.3)}
.sea .linkbtn:hover{color:#F7F3EA;text-decoration-color:#DCA44A}
.sea .grp{background:rgba(247,243,234,.06);border-color:rgba(247,243,234,.22);color:#F7F3EA}
.sea .grp:hover{background:rgba(247,243,234,.12)}
.sea .grp span{color:#C9D6D9}
.sea .grp.on{background:#DCA44A;border-color:#DCA44A;color:#09262F}
.sea .grp.on span{color:#3D2A08}
.sea .act{background:rgba(247,243,234,.06);border-color:rgba(247,243,234,.18)}
.sea .act.on{background:rgba(247,243,234,.1);border:2px solid #DCA44A;box-shadow:none}
.sea .aprice,.sea .chosen,.sea .hint,.sea .info dt,.sea .tip,.sea .glabel{color:#C9D6D9}
.sea .info summary{color:#8FD0D4;text-decoration-color:rgba(143,208,212,.5)}
.sea .info summary::after{color:#DCA44A}
.sea .stepper{background:rgba(247,243,234,.08);border-color:rgba(247,243,234,.22)}
.sea .stepper button{color:#F7F3EA}
.sea .stepper button:hover:not(:disabled){background:rgba(247,243,234,.14)}
.sea .stepper button:disabled{color:rgba(247,243,234,.28)}
.sea .cal{background:rgba(9,38,47,.32);border-color:rgba(247,243,234,.16)}
.sea .calh button{color:#F7F3EA}
.sea .calh button:hover:not(:disabled){background:rgba(247,243,234,.12)}
.sea .calh button:disabled{color:rgba(247,243,234,.25)}
.sea .calg .wd{color:#C9D6D9}
.sea .day{color:#F7F3EA}
.sea .day:hover:not(:disabled){background:rgba(247,243,234,.14)}
.sea .day.off{color:rgba(247,243,234,.32);background:repeating-linear-gradient(135deg,transparent 0 5px,rgba(247,243,234,.08) 5px 6px)}
.sea .day.sel,.sea .day.sel:hover:not(:disabled){background:#DCA44A;color:#09262F}
.sea .day.in,.sea .day.in:hover:not(:disabled){background:rgba(220,164,74,.38);color:#F7F3EA}
.sea .day i{background:#8FD0D4;color:#09262F}
.sea .day i.full{background:#F7F3EA;color:#09262F}
.sea .day.off i{opacity:.7}
.sea .day.hot{box-shadow:inset 0 0 0 2px #F0A040}
.sea .slots button{background:transparent;border-color:rgba(247,243,234,.32);color:#F7F3EA}
.sea .slots button.on{background:#DCA44A;border-color:#DCA44A;color:#09262F}
.sea .done{background:#F7F3EA;color:#09262F}
.sea .done:hover,.sea .done:disabled:hover{background:#fff}
.sea .lbtn{color:#F7F3EA}
.sea .lbtn .pen{color:#C9D6D9}
.sea .x{color:#C9D6D9}
.sea .x:hover{background:rgba(255,155,143,.15);color:#FF9B8F}
.sea .another{border-color:rgba(247,243,234,.42);color:#F7F3EA}
.sea .another:hover{background:rgba(247,243,234,.08)}
.sea .error{color:#FFB4AB}
.sea .note-orange,.sea .warn{background:rgba(220,164,74,.16);border:1px solid rgba(220,164,74,.55);color:#F6DDB0}
.sea .lwarn{color:#F6DDB0}
.sea .slate{border-color:rgba(247,243,234,.16)}
.sea .slate .above{background:#11505E;color:#F7F3EA}
.sea .waterline{background:#11505E}
.sea .waterline path{fill:#061C23}
.sea .slate .below{background:#061C23}
.sea .now b{color:#DCA44A}
.sea .total,.sea .row.sub,.sea .fine{color:#C9D6D9}
.sea .book{background:#DCA44A;color:#09262F}
.sea .book:hover{background:#F7F3EA;color:#09262F}
.sea textarea{background:rgba(247,243,234,.08);border-color:rgba(247,243,234,.22);color:#F7F3EA}
.sea textarea::placeholder{color:rgba(201,214,217,.75)}
.sea .policy{background:rgba(247,243,234,.06);border-color:rgba(247,243,234,.16)}
.sea .policy ul,.sea .terms,.sea .ask,.sea .practical dt,.sea .booked,.sea .course,.sea .oref,.sea .intro{color:#C9D6D9}
.sea .booked strong,.sea .oref b{color:#F7F3EA}
.sea .ask a,.sea .practical a.map,.sea .terms a{color:#8FD0D4;text-decoration-color:rgba(143,208,212,.5)}
.sea .practical{border-top-color:rgba(247,243,234,.16)}
.sea .msg{background:rgba(247,243,234,.1);color:#F7F3EA}
.sea .empty p{color:#C9D6D9}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
