const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/Services.jsm");

const asyncHistory = Cc["@mozilla.org/browser/history;1"]
                       .getService(Ci.mozIAsyncHistory);

const HISTORY_DB_FILENAME = "History";
const BOOKMARKS_DB_FILENAME = "Bookmarks";
//TODO favicons
//TODO logins

const HOMEDIR = Services.dirsvc.get("Home", Ci.nsIFile);

const CHROME_PROFILE_DIR = HOMEDIR.clone();
//XXX OSX
["Library", "Application Support", "Google", "Chrome", "Default"].forEach(
  function(dir) {
    CHROME_PROFILE_DIR.append(dir);
  }
);

const HISTORY_DB_FILE = CHROME_PROFILE_DIR.clone();
HISTORY_DB_FILE.append(HISTORY_DB_FILENAME);

const BOOKMARKS_DB_FILE = CHROME_PROFILE_DIR.clone();
BOOKMARKS_DB_FILE.append(BOOKMARKS_DB_FILENAME);

const URL_QUERY = "SELECT id, url, title FROM urls";
//TODO referrer
const VISITS_QUERY = "SELECT visit_time, transition FROM visits WHERE url = :url_id";

// content/common/page_transition_types.h
const ChromePageTransitions = {
  // User got to this page by clicking a link on another page.
  LINK: 0,
  // User got this page by typing the URL in the URL bar.
  TYPED: 1,
  // User got to this page through a suggestion in the UI.
  AUTO_BOOKMARK: 2,
  // This is a subframe navigation. This is any content that is automatically
  // loaded in a non-toplevel frame.
  AUTO_SUBFRAME: 3,
  // For subframe navigations that are explicitly requested by the user and
  // generate new navigation entries in the back/forward list.
  MANUAL_SUBFRAME: 4,
  // User got to this page by typing in the URL bar and selecting an entry
  // that did not look like a URL.
  GENERATED: 5,
  // The page was specified in the command line or is the start page.
  START_PAGE: 6,
  // The user filled out values in a form and submitted it.
  FORM_SUBMIT: 7,
  // The user "reloaded" the page.
  RELOAD: 8,
  // The url was generated from a replaceable keyword other than the default
  // search provider.
  KEYWORD: 9,
  // Corresponds to a visit generated for a keyword. See description of
  // KEYWORD for more details.
  KEYWORD_GENERATED: 10,

  // The beginning of a navigation chain.
  CHAIN_START: 0x10000000,
  // The last transition in a redirect chain.
  CHAIN_END: 0x20000000,
  // Redirects caused by JavaScript or a meta refresh tag on the page.
  CLIENT_REDIRECT: 0x40000000,
  // Redirects sent from the server by HTTP headers.
  SERVER_REDIRECT: 0x80000000,
  // Used to test whether a transition involves a redirect.
  IS_REDIRECT_MASK: 0xC0000000,

  // General mask defining the bits used for the qualifiers.
  QUALIFIER_MASK: 0xFFFFFF00,


  // Returns whether a transition involves a redirection
  isRedirect: function isRedirect(type) {
    return (type & ChromePageTransitions.IS_REDIRECT_MASK) != 0;
  },
  // Simplifies the provided transition by removing any qualifier
  stripQualifier: function stripQualifier(type) {
    return type & ~ChromePageTransitions.QUALIFIER_MASK;
  }
};

const MapChromeToGeckoTransitions = {
  "LINK":  "TRANSITION_LINK",
  "TYPED": "TRANSITION_TYPED",
  "AUTO_BOOKMARK": "TRANSITION_BOOKMARK",
  "AUTO_SUBFRAME": "TRANSITION_EMBED",
  "MANUAL_SUBFRAME": "TRANSITION_EMBED"
};
for (let transitionName in ChromePageTransitions) {
  MapChromeToGeckoTransitions[ChromePageTransitions[transitionName]]
    = Ci.nsINavHistoryService[MapChromeToGeckoTransitions[transitionName]];
}


function startup(aData, aReason) {
  importHistory(function() {
    dump("Finished importing history.\n");
  });
}

function importHistory(callback) {
  dump(HISTORY_DB_FILE.exists() + "\n");

  let history_db = Services.storage.openDatabase(HISTORY_DB_FILE);
  let url_stm = history_db.createAsyncStatement(URL_QUERY);
  let visits_stm = history_db.createAsyncStatement(VISITS_QUERY);

  url_stm.executeAsync({
    handleCompletion: function handleCompletion(aReason) {
      if (aReason !== Ci.mozIStorageStatementCallback.REASON_FINISHED) {
        dump("Failed to fetch URLs\n");
      }
      history_db.asyncClose({
        complete: callback
      });
    },
    handleError: function handleError(aError) {
      dump("Fetching URLs encountered error: " + aError + "\n");
    },
    handleResult: function handleResult(aResultSet) {
      let row;
      while ((row = aResultSet.getNextRow())) {
        let id = row.getResultByName("id");
        let url = row.getResultByName("url");
        let uri;
        try {
          uri = Services.io.newURI(url, null, null);
        } catch(ex) {
          dump("Can't add URL " + url + "\n");
          continue;
        }
        let title = row.getResultByName("title");
        let placeInfo = {
          uri: uri,
          title: title,
          visits: []
        };

        visits_stm.params.url_id = id;
        visits_stm.executeAsync({
          handleCompletion: function handleCompletion(aReason) {
            if (aReason !== Ci.mozIStorageStatementCallback.REASON_FINISHED) {
              dump("Failed to fetch visits for " + url + "\n");
              return;
            }
            asyncHistory.updatePlaces(placeInfo);
          },
          handleError: function handleError(aError) {
            dump("Fetching visits for " + url + " encountered error: "
                 + aError + "\n");
          },
          handleResult: function handleResult(aResultSet) {
            let row;
            while ((row = aResultSet.getNextRow())) {
              let visit_time = row.getResultByName("visit_time");
              let transition = row.getResultByName("transition");

              if (ChromePageTransitions.isRedirect(transition)) {
                transition = Ci.nsINavHistoryService.TRANSITION_REDIRECT_TEMPORARY;
              } else {
                transition = ChromePageTransitions.stripQualifier(transition);
                transition = MapChromeToGeckoTransitions[transition]
                               || Ci.nsINavHistoryService.TRANSITION_LINK;
              }

              placeInfo.visits.push({visitDate: visit_time,
                                     transitionType: transition});
            }
          }
        });
      }
    }
  });
}

function importBookmarks(callback) {
  //TODO
}

function shutdown(aData, aReason) {
  // Easily reload scripts: auto-enable when disabling
  AddonManager.getAddonByID(aData.id, function(addon) {
    addon.userDisabled = false;
  });
}
